// ============================================================
// STUDY PREMIUM COURSE  - PRODUCTION BACKEND
// File: server.js
// ============================================================

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const multer = require("multer");
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch {}

const app = express();
const PORT = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET || JWT_SECRET;

if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET is missing.");
  process.exit(1);
}

// ============================================================
// DIRECTORIES
// ============================================================

const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(publicDir, "uploads");

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ============================================================
// APP CONFIG
// ============================================================

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(compression());

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

// ============================================================
// RAZORPAY WEBHOOK
// MUST be registered before express.json()
// ============================================================

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers["x-razorpay-signature"];

      if (!secret) {
        console.error("RAZORPAY_WEBHOOK_SECRET is missing.");
        return res.status(500).json({ error: "Webhook secret is not configured." });
      }
      if (!signature) {
        return res.status(400).json({ error: "Missing webhook signature." });
      }

      const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(String(signature), "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Invalid webhook signature." });
      }

      const event = JSON.parse(req.body.toString("utf8"));
      const payment = event?.payload?.payment?.entity;
      const orderEntity = event?.payload?.order?.entity;
      const razorpayOrderId = payment?.order_id || orderEntity?.id || "";
      const razorpayPaymentId = payment?.id || "";

      if (event.event === "payment.captured" || event.event === "order.paid") {
        if (razorpayOrderId) {
          const order = await Order.findOne({ razorpayOrderId });
          if (order) {
            if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
            order.status = "paid";
            await order.save();
            await BatchOwnership.findOneAndUpdate(
              { orderId: order._id },
              { $set: { appId: order.appId, ownerEmail: normalizeEmail(order.customerEmail), orderId: order._id, active: true } },
              { upsert: true, new: true, setDefaultsOnInsert: true }
            );
          }

          const donation = await DonationPayment.findOne({ razorpayOrderId });
          if (donation) {
            if (razorpayPaymentId) donation.razorpayPaymentId = razorpayPaymentId;
            donation.status = "paid";
            await donation.save();
          }
        }
      }

      if (event.event === "payment.authorized" && razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (order && order.status !== "paid") {
          if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
          order.status = "created";
          await order.save();
        }
      }

      if (event.event === "payment.failed" && razorpayOrderId) {
        const order = await Order.findOne({ razorpayOrderId });
        if (order && order.status !== "paid") {
          if (razorpayPaymentId) order.razorpayPaymentId = razorpayPaymentId;
          order.status = "failed";
          await order.save();
        }
        const donation = await DonationPayment.findOne({ razorpayOrderId });
        if (donation && donation.status !== "paid") {
          if (razorpayPaymentId) donation.razorpayPaymentId = razorpayPaymentId;
          donation.status = "failed";
          await donation.save();
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("RAZORPAY WEBHOOK ERROR:", error);
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  }
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb"
  })
);

// ============================================================
// RATE LIMIT
// ============================================================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);

// ============================================================
// FILE UPLOAD
// ============================================================

const allowedImageTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    const safeName =
      path
        .basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9-_]/g, "-")
        .substring(0, 50) || "image";

    const unique =
      Date.now() +
      "-" +
      crypto.randomBytes(6).toString("hex");

    cb(null, `${safeName}-${unique}${ext}`);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 8 * 1024 * 1024
  },

  fileFilter: function (req, file, cb) {
    if (!allowedImageTypes.includes(file.mimetype)) {
      return cb(
        new Error(
          "Only JPG, PNG, WEBP and GIF images are allowed."
        )
      );
    }

    cb(null, true);
  }
});

// ============================================================
// BACKBLAZE B2 STORAGE
// ============================================================
//
// IMPORTANT:
//
// B2_KEY_ID = Application Key ID
// B2_APPLICATION_KEY = actual Application Key
// B2_BUCKET_NAME = exact bucket name
// B2_BUCKET_ID = optional but recommended
//
// Never expose these values to frontend.
// ============================================================

let b2AuthCache = null;
let b2BucketCache = null;

function envValue(name) {
  const value = String(process.env[name] || "").trim();

  if (
    value.length >= 2 &&
    (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function b2KeyId() {
  return (
    envValue("B2_KEY_ID") ||
    envValue("B2_APPLICATION_KEY_ID")
  );
}

function b2ApplicationKey() {
  return (
    envValue("B2_APPLICATION_KEY") ||
    envValue("B2_KEY")
  );
}

function b2BucketName() {
  return envValue("B2_BUCKET_NAME");
}

function b2BucketId() {
  return envValue("B2_BUCKET_ID");
}

function b2Configured() {
  return Boolean(
    b2KeyId() &&
    b2ApplicationKey() &&
    b2BucketName()
  );
}

function resetB2Cache() {
  b2AuthCache = null;
  b2BucketCache = null;
}

function b2ConfigStatus() {
  return {
    configured: b2Configured(),
    keyIdPresent: Boolean(b2KeyId()),
    applicationKeyPresent: Boolean(b2ApplicationKey()),
    bucketNamePresent: Boolean(b2BucketName()),
    bucketIdPresent: Boolean(b2BucketId()),
    bucketName: b2BucketName() || null
  };
}

// ============================================================
// B2 AUTHORIZE
// ============================================================

async function b2Authorize(force = false) {
  if (!b2Configured()) {
    const missing = [];

    if (!b2KeyId()) {
      missing.push("B2_KEY_ID");
    }

    if (!b2ApplicationKey()) {
      missing.push("B2_APPLICATION_KEY");
    }

    if (!b2BucketName()) {
      missing.push("B2_BUCKET_NAME");
    }

    throw new Error(
      `Backblaze B2 is not configured. Missing: ${missing.join(", ")}`
    );
  }

  if (
    !force &&
    b2AuthCache &&
    b2AuthCache.expiresAt > Date.now() + 60000
  ) {
    return b2AuthCache;
  }

  const keyId = b2KeyId();
  const applicationKey = b2ApplicationKey();

  const basic = Buffer
    .from(`${keyId}:${applicationKey}`, "utf8")
    .toString("base64");

  let response;

  try {
    response = await fetch(
      "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${basic}`
        }
      }
    );
  } catch (error) {
    throw new Error(
      `Could not connect to Backblaze B2: ${error.message}`
    );
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("B2 AUTH FAILED:", {
      httpStatus: response.status,
      code: data.code || "",
      message: data.message || ""
    });

    let reason =
      data.message ||
      data.code ||
      `HTTP ${response.status}`;

    if (
      data.code === "bad_auth_token" ||
      data.code === "unauthorized"
    ) {
      reason =
        "Invalid Backblaze Application Key ID or Application Key. " +
        "Use the Application Key ID and the actual Application Key, not the key name.";
    }

    throw new Error(
      `Backblaze authorization failed: ${reason}`
    );
  }

  if (
    !data.authorizationToken ||
    !data.apiUrl ||
    !data.downloadUrl ||
    !data.accountId
  ) {
    throw new Error(
      "Backblaze authorization returned an incomplete response."
    );
  }

  b2AuthCache = {
    ...data,

    expiresAt:
      Date.now() +
      23 * 60 * 60 * 1000
  };

  return b2AuthCache;
}

// ============================================================
// B2 BUCKET
// ============================================================

async function b2GetBucket(force = false) {
  if (
    !force &&
    b2BucketCache &&
    b2BucketCache.bucketId &&
    b2BucketCache.bucketName
  ) {
    return b2BucketCache;
  }

  const configuredBucketId =
    b2BucketId();

  // If bucket ID is supplied, don't call list buckets.
  // This also works better with restricted application keys.
  if (configuredBucketId) {
    b2BucketCache = {
      bucketId: configuredBucketId,
      bucketName: b2BucketName()
    };

    return b2BucketCache;
  }

  const auth =
    await b2Authorize(force);

  let response;

  try {
    response = await fetch(
      `${auth.apiUrl}/b2api/v2/b2_list_buckets`,
      {
        method: "POST",

        headers: {
          Authorization:
            auth.authorizationToken,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          accountId:
            auth.accountId,

          bucketName:
            b2BucketName()
        })
      }
    );
  } catch (error) {
    throw new Error(
      `Could not connect to Backblaze bucket API: ${error.message}`
    );
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    if (
      response.status === 401 &&
      !force
    ) {
      resetB2Cache();
      return b2GetBucket(true);
    }

    throw new Error(
      data.message ||
      data.code ||
      "Could not find Backblaze bucket."
    );
  }

  const bucket =
    (data.buckets || [])[0];

  if (!bucket) {
    throw new Error(
      `Backblaze bucket "${b2BucketName()}" was not found.`
    );
  }

  b2BucketCache = {
    bucketId:
      bucket.bucketId,

    bucketName:
      bucket.bucketName
  };

  return b2BucketCache;
}

// ============================================================
// B2 SAFE FILE NAME
// ============================================================

function b2SafeName(name) {
  return String(name || "file")
    .replace(
      /[^a-zA-Z0-9._/-]/g,
      "-"
    )
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .substring(0, 240);
}

// ============================================================
// B2 GET UPLOAD URL
// ============================================================

async function b2GetUploadUrl(
  auth,
  bucket
) {
  let response;

  try {
    response = await fetch(
      `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
      {
        method: "POST",

        headers: {
          Authorization:
            auth.authorizationToken,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          bucketId:
            bucket.bucketId
        })
      }
    );
  } catch (error) {
    throw new Error(
      `Could not connect to Backblaze upload API: ${error.message}`
    );
  }

  const data =
    await response.json().catch(() => ({}));

  if (!response.ok) {
    const error =
      new Error(
        data.message ||
        data.code ||
        "Could not get B2 upload URL."
      );

    error.status =
      response.status;

    error.b2Code =
      data.code || "";

    throw error;
  }

  if (
    !data.uploadUrl ||
    !data.authorizationToken
  ) {
    throw new Error(
      "Backblaze returned an incomplete upload URL response."
    );
  }

  return data;
}

// ============================================================
// B2 UPLOAD FILE
// ============================================================

async function b2UploadFile(
  filePath,
  fileName,
  contentType
) {
  if (!b2Configured()) {
    throw new Error(
      "Backblaze B2 is not configured on the server."
    );
  }

  const stat =
    await fs.promises.stat(filePath);

  const sha1 =
    crypto.createHash("sha1");

  await new Promise(
    (resolve, reject) => {
      const stream =
        fs.createReadStream(filePath);

      stream.on(
        "data",
        chunk => sha1.update(chunk)
      );

      stream.on(
        "end",
        resolve
      );

      stream.on(
        "error",
        reject
      );
    }
  );

  const sha1Hex =
    sha1.digest("hex");

  let auth =
    await b2Authorize(false);

  let bucket =
    await b2GetBucket(false);

  for (
    let attempt = 0;
    attempt < 2;
    attempt++
  ) {
    try {
      const uploadData =
        await b2GetUploadUrl(
          auth,
          bucket
        );

      const safeName =
        b2SafeName(fileName);

      const putResponse =
        await fetch(
          uploadData.uploadUrl,
          {
            method: "POST",

            headers: {
              Authorization:
                uploadData.authorizationToken,

              "X-Bz-File-Name":
                encodeURIComponent(
                  safeName
                ),

              "Content-Type":
                contentType ||
                "application/octet-stream",

              "Content-Length":
                String(stat.size),

              "X-Bz-Content-Sha1":
                sha1Hex
            },

            body:
              fs.createReadStream(
                filePath
              ),

            duplex: "half"
          }
        );

      const putData =
        await putResponse
          .json()
          .catch(() => ({}));

      if (!putResponse.ok) {
        const error =
          new Error(
            putData.message ||
            putData.code ||
            "Backblaze upload failed."
          );

        error.status =
          putResponse.status;

        error.b2Code =
          putData.code || "";

        throw error;
      }

      return {
        fileId:
          putData.fileId,

        fileName:
          putData.fileName,

        contentType:
          contentType ||
          "application/octet-stream",

        size:
          stat.size
      };
    } catch (error) {
      const retryable =
        error.status === 401 ||
        error.b2Code ===
        "expired_auth_token";

      if (
        !retryable ||
        attempt === 1
      ) {
        throw error;
      }

      console.warn(
        "B2 token expired/unauthorized. Re-authorizing once..."
      );

      resetB2Cache();

      auth =
        await b2Authorize(true);

      bucket =
        await b2GetBucket(true);
    }
  }

  throw new Error(
    "Backblaze upload failed."
  );
}

// ============================================================
// B2 DOWNLOAD
// ============================================================

async function b2DownloadStream(
  fileName,
  res
) {
  let auth =
    await b2Authorize(false);

  const safeName =
    b2SafeName(fileName);

  if (!safeName) {
    throw new Error(
      "Invalid Backblaze file name."
    );
  }

  const encodedPath =
    safeName
      .split("/")
      .map(part =>
        encodeURIComponent(part)
      )
      .join("/");

  function makeUrl(authData) {
    return (
      `${authData.downloadUrl}/file/` +
      `${encodeURIComponent(
        b2BucketName()
      )}/` +
      encodedPath
    );
  }

  let response =
    await fetch(
      makeUrl(auth),
      {
        headers: {
          Authorization:
            auth.authorizationToken
        }
      }
    );

  if (response.status === 401) {
    resetB2Cache();

    auth =
      await b2Authorize(true);

    response =
      await fetch(
        makeUrl(auth),
        {
          headers: {
            Authorization:
              auth.authorizationToken
          }
        }
      );
  }

  if (
    !response.ok ||
    !response.body
  ) {
    const text =
      await response
        .text()
        .catch(() => "");

    throw new Error(
      `Backblaze file could not be downloaded (${response.status}). ${text}`
    );
  }

  const type =
    response.headers.get(
      "content-type"
    );

  const length =
    response.headers.get(
      "content-length"
    );

  if (type) {
    res.setHeader(
      "Content-Type",
      type
    );
  }

  if (length) {
    res.setHeader(
      "Content-Length",
      length
    );
  }

  res.setHeader(
    "Cache-Control",
    "private, no-store"
  );

  const {
    Readable
  } = require("stream");

  Readable
    .fromWeb(response.body)
    .pipe(res);
}

// ============================================================
// MONGOOSE SCHEMAS
// ============================================================

const appSchema =
  new mongoose.Schema(
    {
      name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 150
      },

      developer: {
        type: String,
        default: "STUDY PREMIUM COURSE ",
        trim: true
      },

      category: {
        type: String,
        default: "Education",
        trim: true
      },

      description: {
        type: String,
        default: ""
      },

      logo: {
        type: String,
        default: ""
      },

      logoKey: {
        type: String,
        default: ""
      },

      screenshots: {
        type: [String],
        default: []
      },

      screenshotKeys: {
        type: [String],
        default: []
      },

      banner: {
        type: String,
        default: ""
      },

      bannerKey: {
        type: String,
        default: ""
      },

      price: {
        type: Number,
        default: 0,
        min: 0
      },

      websiteUrl: {
        type: String,
        default: ""
      },

      downloadUrl: {
        type: String,
        default: ""
      },

      appFileKey: {
        type: String,
        default: ""
      },

      appFileName: {
        type: String,
        default: ""
      },

      appFileMime: {
        type: String,
        default: ""
      },

      appFileSize: {
        type: Number,
        default: 0
      },

      accessType: {
        type: String,
        enum: [
          "free",
          "paid"
        ],
        default: "free"
      },

      validity: {
        type: String,
        default: "Lifetime"
      },

      rating: {
        type: Number,
        default: 4.8,
        min: 0,
        max: 5
      },

      downloads: {
        type: Number,
        default: 0
      },

      featured: {
        type: Boolean,
        default: false
      },

      trending: {
        type: Boolean,
        default: false
      },

      published: {
        type: Boolean,
        default: true
      },

      upcoming: {
        type: Boolean,
        default: false
      }
    },
    {
      timestamps: true
    }
  );

const orderSchema =
  new mongoose.Schema(
    {
      razorpayOrderId: {
        type: String,
        unique: true,
        sparse: true
      },

      razorpayPaymentId: {
        type: String,
        default: ""
      },

      appId: {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "App",
        required: true
      },

      appName: {
        type: String,
        default: ""
      },

      amount: {
        type: Number,
        required: true
      },

      currency: {
        type: String,
        default: "INR"
      },

      status: {
        type: String,
        enum: [
          "created",
          "paid",
          "failed"
        ],
        default: "created"
      },

      customerName: {
        type: String,
        default: ""
      },

      customerEmail: {
        type: String,
        default: ""
      },

      customerPhone: {
        type: String,
        default: ""
      }
    },
    {
      timestamps: true
    }
  );

const accessSchema =
  new mongoose.Schema(
    {
      tokenHash: {
        type: String,
        required: true,
        unique: true
      },

      orderId: {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "Order",
        required: true
      },

      appId: {
        type:
          mongoose.Schema.Types.ObjectId,
        ref: "App",
        required: true
      },

      type: {
        type: String,
        enum: [
          "app",
          "website"
        ],
        required: true
      },

      expiresAt: {
        type: Date,
        required: true
      },

      usedAt: {
        type: Date,
        default: null
      }
    },
    {
      timestamps: true
    }
  );

const adminSchema =
  new mongoose.Schema(
    {
      username: {
        type: String,
        unique: true,
        required: true
      },

      passwordHash: {
        type: String,
        required: true
      },

      secretHash: {
        type: String,
        required: true
      }
    },
    {
      timestamps: true
    }
  );

const settingsSchema =
  new mongoose.Schema(
    {
      key: {
        type: String,
        unique: true,
        default: "main"
      },

      title: {
        type: String,
        default: "STUDY PREMIUM COURSE "
      },

      tagline: {
        type: String,
        default:
          "LEARN • PREPARE • SUCCEED"
      }
    },
    {
      timestamps: true
    }
  );


// ============================================================
// USER + BATCH OWNERSHIP + DONATION
// ============================================================

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true }
}, { timestamps: true });

const batchOwnershipSchema = new mongoose.Schema({
  appId: { type: mongoose.Schema.Types.ObjectId, ref: "App", required: true },
  ownerEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  active: { type: Boolean, default: true },
  donatedAt: { type: Date, default: null }
}, { timestamps: true });

const donationSchema = new mongoose.Schema({
  ownershipId: { type: mongoose.Schema.Types.ObjectId, ref: "BatchOwnership", required: true },
  appId: { type: mongoose.Schema.Types.ObjectId, ref: "App", required: true },
  donorEmail: { type: String, required: true, lowercase: true, trim: true },
  recipientEmail: { type: String, required: true, lowercase: true, trim: true },
  otpHash: { type: String, required: true },
  otpExpiresAt: { type: Date, required: true },
  status: { type: String, enum: ["pending_otp", "pending_admin", "approved", "rejected", "completed", "cancelled"], default: "pending_otp" },
  verifiedAt: { type: Date, default: null },
  approvedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: "" }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);
const BatchOwnership = mongoose.model("BatchOwnership", batchOwnershipSchema);
const Donation = mongoose.model("Donation", donationSchema);
const donationPaymentSchema = new mongoose.Schema({
  donorName: { type: String, required: true, trim: true, maxlength: 100 },
  donorEmail: { type: String, required: true, lowercase: true, trim: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, default: "INR" },
  razorpayOrderId: { type: String, unique: true, sparse: true },
  razorpayPaymentId: { type: String, default: "" },
  status: { type: String, enum: ["created", "paid", "failed"], default: "created" }
}, { timestamps: true });

const DonationPayment = mongoose.model("DonationPayment", donationPaymentSchema);


const AppModel =
  mongoose.model(
    "App",
    appSchema
  );

const Order =
  mongoose.model(
    "Order",
    orderSchema
  );

const Access =
  mongoose.model(
    "Access",
    accessSchema
  );

const Admin =
  mongoose.model(
    "Admin",
    adminSchema
  );

const Settings =
  mongoose.model(
    "Settings",
    settingsSchema
  );

// ============================================================
// RAZORPAY
// ============================================================

let razorpay = null;

function getRazorpay() {
  if (
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
  ) {
    return null;
  }

  if (!razorpay) {
    razorpay =
      new Razorpay({
        key_id:
          process.env.RAZORPAY_KEY_ID,

        key_secret:
          process.env.RAZORPAY_KEY_SECRET
      });
  }

  return razorpay;
}

// ============================================================
// HELPERS
// ============================================================

function signAdmin(admin) {
  return jwt.sign(
    {
      sub:
        admin._id.toString(),

      username:
        admin.username,

      role: "admin"
    },

    JWT_SECRET,

    {
      expiresIn: "12h"
    }
  );
}


function signUser(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: "user" },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

async function requireUser(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "user") throw new Error("Forbidden");
    const user = await User.findById(decoded.sub).lean();
    if (!user) throw new Error("User not found");
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired login" });
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function sendDonationOtp(recipientEmail, otp, donorName, batchName) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const from = String(process.env.SMTP_FROM || user || "").trim();

  if (host && user && pass && nodemailer) {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass }
    });
    await transporter.sendMail({
      from,
      to: recipientEmail,
      subject: `Batch donation verification - ${batchName}`,
      text: `${donorName || "A user"} wants to donate ${batchName} to you. Your OTP is ${otp}. It expires in 10 minutes.`
    });
    return { sent: true, developmentOtp: null };
  }

  if (String(process.env.DONATION_DEV_OTP || (process.env.NODE_ENV === "production" ? "false" : "true")).toLowerCase() === "true") {
    console.log(`[DONATION DEV OTP] ${recipientEmail}: ${otp}`);
    return { sent: false, developmentOtp: otp };
  }

  throw new Error("Donation email service is not configured. Set SMTP_* or enable DONATION_DEV_OTP for local testing.");
}

function createAccessToken() {
  return crypto.randomBytes(48).toString("hex");
}

function hashAccessToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function validHttpUrl(value) {
  if (!value) return true;

  try {
    const u =
      new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function normalizeAppBody(body) {
  const price =
    Number(body.price || 0);

  return {
    name:
      String(body.name || "")
        .trim(),

    developer:
      String(
        body.developer ||
        "STUDY PREMIUM COURSE "
      ).trim(),

    category:
      String(
        body.category ||
        "Education"
      ).trim(),

    description:
      String(
        body.description || ""
      ),

    logo:
      String(
        body.logo || ""
      ),

    logoKey:
      String(
        body.logoKey || ""
      ),

    screenshots:
      Array.isArray(
        body.screenshots
      )
        ? body.screenshots.filter(
          Boolean
        )
        : [],

    screenshotKeys:
      Array.isArray(
        body.screenshotKeys
      )
        ? body.screenshotKeys.filter(
          Boolean
        )
        : [],

    banner:
      String(
        body.banner || ""
      ),

    bannerKey:
      String(
        body.bannerKey || ""
      ),

    price,

    websiteUrl:
      String(
        body.websiteUrl || ""
      ).trim(),

    downloadUrl:
      String(
        body.downloadUrl || ""
      ).trim(),

    appFileKey:
      String(
        body.appFileKey || ""
      ).trim(),

    appFileName:
      String(
        body.appFileName || ""
      ).trim(),

    appFileMime:
      String(
        body.appFileMime || ""
      ).trim(),

    appFileSize:
      Number(
        body.appFileSize || 0
      ),

    accessType:
      price > 0
        ? "paid"
        : "free",

    validity:
      String(
        body.validity ||
        "Lifetime"
      ),

    rating:
      Number(
        body.rating || 4.8
      ),

    featured:
      Boolean(body.featured),

    trending:
      Boolean(body.trending),

    published:
      body.published !== false
  };
}

// ============================================================
// ADMIN AUTH
// ============================================================

function requireAdmin(
  req,
  res,
  next
) {
  const header =
    req.headers.authorization ||
    "";

  const token =
    header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

  if (!token) {
    return res.status(401).json({
      error:
        "Admin authentication required"
    });
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (
      decoded.role !==
      "admin"
    ) {
      throw new Error(
        "Forbidden"
      );
    }

    req.admin =
      decoded;

    next();
  } catch {
    return res.status(401).json({
      error:
        "Invalid or expired admin token"
    });
  }
}

// ============================================================
// ACCESS AUTH
// ============================================================

async function requireAccess(
  req,
  res,
  next
) {
  const token =
    req.headers[
    "x-access-token"
    ] ||
    req.query.token ||
    "";

  if (!token) {
    return res.status(401).json({
      error:
        "Access token required"
    });
  }

  try {
    const tokenHash =
      hashAccessToken(token);

    const access =
      await Access.findOne({
        tokenHash,

        expiresAt: {
          $gt: new Date()
        },

        usedAt: null
      });

    if (!access) {
      return res.status(403).json({
        error:
          "Access token expired or invalid"
      });
    }

    req.access =
      access;

    next();
  } catch {
    return res.status(403).json({
      error:
        "Access denied"
    });
  }
}


// ============================================================
// USER AUTH
// ============================================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: "Name, valid email and password (6+ characters) are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Account already exists. Please login." });
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    res.status(201).json({ success: true, token: signUser(user), user: { id: user._id, name: user.name, email: user.email } });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    res.json({ success: true, token: signUser(user), user: { id: user._id, name: user.name, email: user.email } });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/auth/me", requireUser, (req, res) => {
  res.json({ user: { id: req.user._id, name: req.user.name, email: req.user.email } });
});

// ============================================================
// MY BATCHES
// ============================================================

app.get("/api/my-batches", requireUser, async (req, res) => {
  try {
    const ownerships = await BatchOwnership.find({ ownerEmail: req.user.email, active: true })
      .populate("appId")
      .sort({ createdAt: -1 })
      .lean();
    res.json(ownerships.map(o => ({
      ownershipId: o._id,
      purchasedAt: o.createdAt,
      donatedAt: o.donatedAt,
      batch: o.appId
    })));
  } catch (error) {
    console.error("MY BATCHES ERROR:", error);
    res.status(500).json({ error: "Unable to load your batches." });
  }
});

app.post("/api/my-batches/access", requireUser, async (req, res) => {
  try {
    const ownership = await BatchOwnership.findOne({ _id: req.body.ownershipId, ownerEmail: req.user.email, active: true });
    if (!ownership) return res.status(404).json({ error: "Batch ownership not found." });
    const item = await AppModel.findById(ownership.appId).lean();
    if (!item) return res.status(404).json({ error: "Batch not found." });
    const order = await Order.findOne({ _id: ownership.orderId, status: "paid" }).lean();
    if (!order) return res.status(403).json({ error: "Original paid order is not valid." });
    const type = String(req.body.type || "app");
    if (!["app", "website"].includes(type)) return res.status(400).json({ error: "Invalid access type." });
    const token = createAccessToken();
    await Access.create({ tokenHash: hashAccessToken(token), orderId: order._id, appId: item._id, type, expiresAt: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000) });
    res.json({ success: true, url: `/api/access/${type === "website" ? "website" : "download"}?token=${encodeURIComponent(token)}` });
  } catch (error) {
    console.error("MY BATCH ACCESS ERROR:", error);
    res.status(500).json({ error: "Unable to create batch access." });
  }
});

// ============================================================
// DONATE BATCH
// ============================================================

app.post("/api/donate/create", requireUser, async (req, res) => {
  try {
    const ownershipId = String(req.body.ownershipId || "").trim();
    const recipientEmail = normalizeEmail(req.body.recipientEmail);
    if (!ownershipId || !recipientEmail) return res.status(400).json({ error: "Batch and recipient email are required." });
    if (recipientEmail === req.user.email) return res.status(400).json({ error: "You cannot donate a batch to yourself." });
    const recipient = await User.findOne({ email: recipientEmail }).lean();
    if (!recipient) return res.status(404).json({ error: "Recipient must create a PREP MASTER account first." });
    const ownership = await BatchOwnership.findOne({ _id: ownershipId, ownerEmail: req.user.email, active: true }).populate("appId");
    if (!ownership) return res.status(403).json({ error: "You do not own this batch." });
    const pending = await Donation.findOne({ ownershipId: ownership._id, status: { $in: ["pending_otp", "pending_admin", "approved"] } });
    if (pending) return res.status(409).json({ error: "A donation request is already pending for this batch." });
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashAccessToken(otp);
    const donation = await Donation.create({ ownershipId, appId: ownership.appId._id, donorEmail: req.user.email, recipientEmail, otpHash, otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    let mail;
    try {
      mail = await sendDonationOtp(recipientEmail, otp, req.user.name, ownership.appId.name);
    } catch (mailError) {
      await Donation.findByIdAndDelete(donation._id);
      return res.status(503).json({ error: mailError.message });
    }
    res.json({ success: true, donationId: donation._id, message: "OTP sent to recipient email.", developmentOtp: mail.developmentOtp || undefined });
  } catch (error) {
    console.error("DONATE CREATE ERROR:", error);
    res.status(500).json({ error: "Could not create donation request." });
  }
});

app.post("/api/donate/verify", requireUser, async (req, res) => {
  try {
    const donation = await Donation.findById(req.body.donationId);
    if (!donation) return res.status(404).json({ error: "Donation request not found." });
    if (donation.donorEmail !== req.user.email) return res.status(403).json({ error: "Not your donation request." });
    if (donation.status !== "pending_otp") return res.status(400).json({ error: "This donation request is no longer waiting for OTP." });
    if (donation.otpExpiresAt < new Date()) { donation.status = "cancelled"; await donation.save(); return res.status(400).json({ error: "OTP has expired." }); }
    if (hashAccessToken(String(req.body.otp || "").trim()) !== donation.otpHash) return res.status(400).json({ error: "Invalid OTP." });
    donation.status = "pending_admin";
    donation.verifiedAt = new Date();
    await donation.save();
    res.json({ success: true, message: "OTP verified. Waiting for provider/admin approval." });
  } catch (error) {
    console.error("DONATE VERIFY ERROR:", error);
    res.status(500).json({ error: "Could not verify donation." });
  }
});

app.get("/api/donations/mine", requireUser, async (req, res) => {
  try {
    const rows = await Donation.find({ $or: [{ donorEmail: req.user.email }, { recipientEmail: req.user.email }] }).populate("appId", "name logo category validity").sort({ createdAt: -1 }).limit(100).lean();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Unable to load donations." });
  }
});

// ============================================================
// ADMIN DONATIONS
// ============================================================

app.get("/api/admin/donations", requireAdmin, async (req, res) => {
  try {
    const rows = await Donation.find({ status: { $in: ["pending_admin", "approved"] } }).populate("appId", "name logo category").sort({ createdAt: -1 }).lean();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Unable to load donation requests." });
  }
});

app.post("/api/admin/donations/:id/approve", requireAdmin, async (req, res) => {
  try {
    const donation = await Donation.findOne({ _id: req.params.id, status: "pending_admin" });
    if (!donation) return res.status(404).json({ error: "Pending donation not found." });
    const ownership = await BatchOwnership.findOne({ _id: donation.ownershipId, ownerEmail: donation.donorEmail, active: true });
    if (!ownership) return res.status(409).json({ error: "Batch is no longer owned by donor." });
    ownership.ownerEmail = donation.recipientEmail;
    ownership.donatedAt = new Date();
    await ownership.save();
    donation.status = "completed";
    donation.approvedAt = new Date();
    donation.completedAt = new Date();
    await donation.save();
    res.json({ success: true, message: "Batch donated successfully." });
  } catch (error) {
    console.error("DONATION APPROVE ERROR:", error);
    res.status(500).json({ error: "Could not approve donation." });
  }
});

app.post("/api/admin/donations/:id/reject", requireAdmin, async (req, res) => {
  try {
    const donation = await Donation.findOneAndUpdate({ _id: req.params.id, status: "pending_admin" }, { status: "rejected", rejectionReason: String(req.body.reason || "Rejected by provider/admin").slice(0, 500) }, { new: true });
    if (!donation) return res.status(404).json({ error: "Pending donation not found." });
    res.json({ success: true, message: "Donation rejected." });
  } catch (error) {
    res.status(500).json({ error: "Could not reject donation." });
  }
});

// ============================================================
// PUBLIC DONATION PAYMENTS + LEADERBOARD
// ============================================================

app.post("/api/donations/payment/order", async (req, res) => {
  try {
    const donorName = String(req.body.donorName || "").trim();
    const donorEmail = normalizeEmail(req.body.donorEmail);
    const amount = Math.round(Number(req.body.amount || 0));

    if (!donorName || donorName.length < 2) {
      return res.status(400).json({ error: "Please enter your name." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail)) {
      return res.status(400).json({ error: "Please enter a valid email." });
    }
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Minimum donation is ₹1." });
    }

    const rp = getRazorpay();
    if (!rp) {
      return res.status(503).json({ error: "Razorpay is not configured on the server." });
    }

    const razorpayOrder = await rp.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: `donate_${Date.now()}`
    });

    await DonationPayment.create({
      donorName,
      donorEmail,
      amount,
      currency: "INR",
      razorpayOrderId: razorpayOrder.id,
      status: "created"
    });

    res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: amount * 100,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      donorName,
      donorEmail
    });
  } catch (error) {
    console.error("DONATION PAYMENT ORDER ERROR:", error);
    res.status(500).json({ error: "Could not create donation payment." });
  }
});

app.post("/api/donations/payment/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Incomplete payment verification data." });
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: "Payment verification is not configured." });
    }

    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected.length !== String(razorpay_signature).length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)))) {
      return res.status(400).json({ error: "Payment signature verification failed." });
    }

    const donation = await DonationPayment.findOne({ razorpayOrderId: razorpay_order_id });
    if (!donation) return res.status(404).json({ error: "Donation payment not found." });
    if (donation.status === "paid") return res.json({ success: true, message: "Donation already recorded." });

    donation.razorpayPaymentId = razorpay_payment_id;
    donation.status = "paid";
    await donation.save();

    res.json({ success: true, message: "Donation received successfully." });
  } catch (error) {
    console.error("DONATION PAYMENT VERIFY ERROR:", error);
    res.status(500).json({ error: "Could not verify donation payment." });
  }
});

app.get("/api/donations/leaderboard", async (req, res) => {
  try {
    const rows = await DonationPayment.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: "$donorEmail", donorName: { $last: "$donorName" }, total: { $sum: "$amount" } } },
      { $sort: { total: -1, donorName: 1 } },
      { $limit: 20 }
    ]);
    res.json(rows.map((x, i) => ({ rank: i + 1, name: x.donorName, amount: x.total })));
  } catch (error) {
    console.error("DONATION LEADERBOARD ERROR:", error);
    res.status(500).json({ error: "Unable to load donation leaderboard." });
  }
});

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "STUDY PREMIUM COURSE",
      time:
        new Date().toISOString()
    });
  }
);

// ============================================================
// CONFIG
// ============================================================

app.get(
  "/api/config",
  (req, res) => {
    res.json({
      razorpayKeyId:
        process.env
          .RAZORPAY_KEY_ID ||
        "",

      publicUrl:
        process.env.PUBLIC_URL ||
        ""
    });
  }
);

// ============================================================
// PUBLIC SETTINGS
// ============================================================

app.get(
  "/api/settings",
  async (req, res) => {
    try {
      const settings =
        await Settings.findOne({
          key: "main"
        }).lean();

      res.json(
        settings || {
          title:
            "STUDY PREMIUM COURSE",

          tagline:
            "LEARN • PREPARE • SUCCEED"
        }
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load website settings."
      });
    }
  }
);

// ============================================================
// PUBLIC APPS
// ============================================================

app.get(
  "/api/apps",
  async (req, res) => {
    try {
      const filter = {
        published: true
      };

      if (
        req.query.category &&
        req.query.category !== "All"
      ) {
        filter.category =
          req.query.category;
      }

      if (req.query.search) {
        filter.name = {
          $regex:
            req.query.search.trim(),

          $options: "i"
        };
      }

      if (req.query.upcoming === "true") {
        filter.upcoming = true;
      }

      const apps =
        await AppModel.find(filter)
          .sort({
            featured: -1,
            trending: -1,
            createdAt: -1
          })
          .lean();

      res.json(apps);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to load apps"
      });
    }
  }
);

// ============================================================
// SINGLE APP
// ============================================================

app.get(
  "/api/apps/:id",
  async (req, res) => {
    try {
      const item =
        await AppModel.findOne({
          _id:
            req.params.id,

          published:
            true
        }).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      res.json(item);
    } catch {
      res.status(400).json({
        error:
          "Invalid app id"
      });
    }
  }
);

// ============================================================
// PAYMENT ORDER
// ============================================================

app.post(
  "/api/payments/order",
  async (req, res) => {
    try {
      const {
        appId,
        customerName = "",
        customerEmail = "",
        customerPhone = ""
      } = req.body;

      if (!appId) {
        return res.status(400).json({
          error:
            "App ID is required"
        });
      }

      if (
        !customerName.trim()
      ) {
        return res.status(400).json({
          error:
            "Customer name is required"
        });
      }

      if (
        !customerEmail.trim()
      ) {
        return res.status(400).json({
          error:
            "Customer email is required"
        });
      }

      const item =
        await AppModel.findOne({
          _id: appId,
          published: true
        });

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      if (
        item.accessType !==
        "paid" ||
        item.price <= 0
      ) {
        return res.status(400).json({
          error:
            "This item is free"
        });
      }

      const rp =
        getRazorpay();

      if (!rp) {
        return res.status(503).json({
          error:
            "Razorpay is not configured on the server."
        });
      }

      const amount =
        Math.round(
          item.price * 100
        );

      const razorpayOrder =
        await rp.orders.create({
          amount,

          currency:
            "INR",

          receipt:
            `pm_${Date.now()}`
        });

      await Order.create({
        razorpayOrderId:
          razorpayOrder.id,

        appId:
          item._id,

        appName:
          item.name,

        amount:
          item.price,

        currency:
          "INR",

        status:
          "created",

        customerName:
          customerName.trim(),

        customerEmail:
          customerEmail.trim(),

        customerPhone:
          customerPhone.trim()
      });

      res.json({
        success:
          true,

        orderId:
          razorpayOrder.id,

        amount,

        currency:
          "INR",

        keyId:
          process.env
            .RAZORPAY_KEY_ID,

        app: {
          id:
            item._id,

          name:
            item.name,

          validity:
            item.validity
        }
      });
    } catch (error) {
      console.error(
        "CREATE ORDER ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not create payment order"
      });
    }
  }
);

// ============================================================
// PAYMENT VERIFY
// ============================================================

app.post(
  "/api/payments/verify",
  async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: "Incomplete payment verification data" });
      }

      const secret = process.env.RAZORPAY_KEY_SECRET;
      if (!secret) {
        return res.status(503).json({ error: "Payment verification is not configured." });
      }

      const expected = crypto.createHmac("sha256", secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(String(razorpay_signature), "utf8");

      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Payment signature verification failed" });
      }

      const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
      if (!order) return res.status(404).json({ error: "Order not found" });

      const rp = getRazorpay();
      if (!rp) return res.status(503).json({ error: "Razorpay is not configured on the server." });

      const payment = await rp.payments.fetch(razorpay_payment_id);

      if (payment.order_id !== razorpay_order_id) {
        return res.status(400).json({ error: "Payment does not belong to this order." });
      }

      if (payment.status !== "captured") {
        if (payment.status === "failed" && order.status !== "paid") {
          order.razorpayPaymentId = razorpay_payment_id;
          order.status = "failed";
          await order.save();
        }
        return res.status(202).json({
          success: false,
          pending: payment.status !== "failed",
          status: payment.status,
          error: payment.status === "failed"
            ? "Razorpay reports this payment as failed. If money was debited, wait for reconciliation before trying again."
            : "Payment is not captured yet. Please wait for confirmation."
        });
      }

      order.razorpayPaymentId = razorpay_payment_id;
      order.status = "paid";
      await order.save();

      await BatchOwnership.findOneAndUpdate(
        { orderId: order._id },
        { $set: { appId: order.appId, ownerEmail: normalizeEmail(order.customerEmail), orderId: order._id, active: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const item = await AppModel.findById(order.appId).lean();
      if (!item) return res.status(404).json({ error: "Purchased item no longer exists" });

      return res.json({
        success: true,
        status: "paid",
        orderId: order._id,
        paymentId: razorpay_payment_id,
        app: {
          id: item._id,
          name: item.name,
          websiteUrl: item.websiteUrl,
          downloadUrl: item.downloadUrl,
          appFileKey: item.appFileKey || "",
          validity: item.validity
        }
      });
    } catch (error) {
      console.error("VERIFY PAYMENT ERROR:", error);
      return res.status(500).json({ error: "Payment verification failed" });
    }
  }
);

// ============================================================
// CHECK PAYMENT STATUS
// ============================================================

app.post(
  "/api/payments/check-status",
  async (req, res) => {
    try {
      const orderId = String(req.body.orderId || "").trim();
      const paymentId = String(req.body.paymentId || "").trim();

      if (!orderId || !paymentId) {
        return res.status(400).json({ error: "Order ID and payment ID are required." });
      }

      const rp = getRazorpay();
      if (!rp) return res.status(503).json({ error: "Razorpay is not configured on the server." });

      const order = await Order.findOne({ razorpayOrderId: orderId });
      if (!order) return res.status(404).json({ error: "Order not found." });

      const payment = await rp.payments.fetch(paymentId);
      if (payment.order_id !== orderId) {
        return res.status(400).json({ error: "Payment does not belong to this order." });
      }

      if (payment.status === "captured") {
        order.razorpayPaymentId = paymentId;
        order.status = "paid";
        await order.save();

        await BatchOwnership.findOneAndUpdate(
          { orderId: order._id },
          { $set: { appId: order.appId, ownerEmail: normalizeEmail(order.customerEmail), orderId: order._id, active: true } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return res.json({ success: true, status: "paid", orderId: order._id, paymentId });
      }

      if (payment.status === "failed") {
        if (order.status !== "paid") {
          order.razorpayPaymentId = paymentId;
          order.status = "failed";
          await order.save();
        }
        return res.json({ success: false, status: "failed" });
      }

      return res.json({ success: false, pending: true, status: payment.status });
    } catch (error) {
      console.error("CHECK PAYMENT STATUS ERROR:", error);
      return res.status(500).json({ error: "Could not check payment status." });
    }
  }
);

// ============================================================
// CREATE ACCESS TOKEN
// ============================================================

app.post(
  "/api/access/create",
  async (req, res) => {
    try {
      const {
        orderId,
        type
      } = req.body;

      if (
        !orderId ||
        ![
          "app",
          "website"
        ].includes(type)
      ) {
        return res.status(400).json({
          error:
            "Invalid access request"
        });
      }

      const order =
        await Order.findOne({
          _id: orderId,
          status: "paid"
        });

      if (!order) {
        return res.status(403).json({
          error:
            "Paid order required"
        });
      }

      const token =
        createAccessToken();

      const tokenHash =
        hashAccessToken(
          token
        );

      const item =
        await AppModel.findById(
          order.appId
        ).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      const expiresAt =
        new Date(
          Date.now() +
          3650 *
          24 *
          60 *
          60 *
          1000
        );

      await Access.create({
        tokenHash,

        orderId:
          order._id,

        appId:
          item._id,

        type,

        expiresAt
      });

      const destination =
        type === "website"
          ? item.websiteUrl
          : (
            item.appFileKey
              ? `/api/access/download?token=${encodeURIComponent(token)}`
              : item.downloadUrl
          );

      if (!destination) {
        return res.status(400).json({
          error:
            "Destination URL or uploaded app file is not configured by admin"
        });
      }

      const url =
        type === "website"
          ? `/api/access/website?token=${encodeURIComponent(token)}`
          : `/api/access/download?token=${encodeURIComponent(token)}`;

      res.json({
        success:
          true,

        token,

        expiresAt,

        type,

        destination,

        url
      });
    } catch (error) {
      console.error(
        "ACCESS TOKEN ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not create access token"
      });
    }
  }
);

// ============================================================
// PRIVATE B2 MEDIA
// ============================================================

app.get(
  "/api/media",
  async (req, res) => {
    try {
      const key =
        String(
          req.query.key || ""
        );

      if (
        !key ||
        key.includes("..") ||
        key.startsWith("/")
      ) {
        return res.status(400).json({
          error:
            "Invalid media key"
        });
      }

      await b2DownloadStream(
        key,
        res
      );
    } catch (error) {
      console.error(
        "MEDIA ERROR:",
        error.message
      );

      if (!res.headersSent) {
        res.status(404).json({
          error:
            "Media not found"
        });
      }
    }
  }
);

// ============================================================
// FREE DOWNLOAD
// ============================================================

app.get(
  "/api/free-download/:id",
  async (req, res) => {
    try {
      const item =
        await AppModel.findOne({
          _id:
            req.params.id,

          published:
            true
        }).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found."
        });
      }

      if (
        item.accessType ===
        "paid" &&
        Number(item.price) > 0
      ) {
        return res.status(402).json({
          error:
            "Payment required."
        });
      }

      if (item.appFileKey) {
        await AppModel.updateOne(
          {
            _id:
              item._id
          },
          {
            $inc: {
              downloads: 1
            }
          }
        );

        const filename =
          String(
            item.appFileName ||
            "app.apk"
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );

        return await b2DownloadStream(
          item.appFileKey,
          res
        );
      }

      if (
        item.downloadUrl
      ) {
        return res.redirect(
          item.downloadUrl
        );
      }

      return res.status(404).json({
        error:
          "App file has not been uploaded."
      });
    } catch (error) {
      console.error(
        "FREE DOWNLOAD ERROR:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          error:
            "Could not download app."
        });
      }
    }
  }
);

// ============================================================
// PAID APP DOWNLOAD
// ============================================================

app.get(
  "/api/access/download",
  async (req, res) => {
    try {
      const token =
        String(
          req.query.token || ""
        );

      if (!token) {
        return res.status(401).json({
          error:
            "Access token required"
        });
      }

      const access =
        await Access.findOneAndUpdate(
          {
            tokenHash:
              hashAccessToken(
                token
              ),

            type:
              "app",

            expiresAt: {
              $gt:
                new Date()
            },

            usedAt:
              null
          },

          {
            $set: {
              usedAt:
                new Date()
            }
          },

          {
            new:
              true
          }
        );

      if (!access) {
        return res.status(403).json({
          error:
            "Download token expired, invalid or already used."
        });
      }

      const item =
        await AppModel.findById(
          access.appId
        ).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      await AppModel.updateOne(
        {
          _id:
            item._id
        },
        {
          $inc: {
            downloads:
              1
          }
        }
      );

      if (
        item.appFileKey
      ) {
        const filename =
          String(
            item.appFileName ||
            "app.apk"
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );

        return await b2DownloadStream(
          item.appFileKey,
          res
        );
      }

      if (
        item.downloadUrl
      ) {
        return res.redirect(
          item.downloadUrl
        );
      }

      return res.status(404).json({
        error:
          "App file has not been uploaded by admin."
      });
    } catch (error) {
      console.error(
        "DOWNLOAD ERROR:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          error:
            "Could not download app."
        });
      }
    }
  }
);

// ============================================================
// WEBSITE ACCESS
// ============================================================

app.get(
  "/api/access/website",
  async (req, res) => {
    try {
      const token =
        String(
          req.query.token || ""
        );

      if (!token) {
        return res.status(401).send(
          "Access token required."
        );
      }

      const access =
        await Access.findOneAndUpdate(
          {
            tokenHash:
              hashAccessToken(
                token
              ),

            type:
              "website",

            expiresAt: {
              $gt:
                new Date()
            },

            usedAt:
              null
          },

          {
            $set: {
              usedAt:
                new Date()
            }
          },

          {
            new:
              true
          }
        );

      if (!access) {
        return res.status(403).send(
          "Access token expired, invalid or already used."
        );
      }

      const item =
        await AppModel.findById(
          access.appId
        ).lean();

      if (
        !item ||
        !item.websiteUrl
      ) {
        return res.status(404).send(
          "Website link is not configured."
        );
      }

      if (
        !validHttpUrl(
          item.websiteUrl
        )
      ) {
        return res.status(400).send(
          "Invalid website URL."
        );
      }

      return res.redirect(
        item.websiteUrl
      );
    } catch (error) {
      console.error(
        "WEBSITE ACCESS ERROR:",
        error
      );

      return res.status(500).send(
        "Could not open website."
      );
    }
  }
);

// ============================================================
// ACCESS CHECK
// ============================================================

app.get(
  "/api/access/check",
  requireAccess,
  async (req, res) => {
    try {
      const item =
        await AppModel.findById(
          req.access.appId
        ).lean();

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      const destination =
        req.access.type ===
          "website"
          ? item.websiteUrl
          : (
            item.appFileKey
              ? "/api/access/download"
              : item.downloadUrl
          );

      if (!destination) {
        return res.status(404).json({
          error:
            "Destination URL not configured"
        });
      }

      res.json({
        success:
          true,

        type:
          req.access.type,

        destination,

        expiresAt:
          req.access.expiresAt
      });
    } catch {
      res.status(500).json({
        error:
          "Could not verify access"
      });
    }
  }
);

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const {
        username,
        password,
        secretKey
      } = req.body;

      const admin =
        await Admin.findOne({
          username
        });

      if (!admin) {
        return res.status(401).json({
          error:
            "Invalid admin credentials"
        });
      }

      const passOk =
        await bcrypt.compare(
          password || "",
          admin.passwordHash
        );

      const secretOk =
        await bcrypt.compare(
          secretKey || "",
          admin.secretHash
        );

      if (
        !passOk ||
        !secretOk
      ) {
        return res.status(401).json({
          error:
            "Invalid admin credentials"
        });
      }

      res.json({
        token:
          signAdmin(admin),

        username:
          admin.username
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Login failed"
      });
    }
  }
);

// ============================================================
// ADMIN B2 STATUS
// ============================================================

app.get(
  "/api/admin/b2-status",
  requireAdmin,
  async (req, res) => {
    try {
      const config =
        b2ConfigStatus();

      if (!config.configured) {
        return res.status(503).json({
          ok:
            false,

          ...config,

          error:
            "B2 environment variables are incomplete."
        });
      }

      const auth =
        await b2Authorize(
          true
        );

      const bucket =
        await b2GetBucket(
          true
        );

      return res.json({
        ok:
          true,

        configured:
          true,

        keyIdPresent:
          true,

        applicationKeyPresent:
          true,

        bucketName:
          bucket.bucketName,

        bucketId:
          bucket.bucketId,

        apiUrl:
          auth.apiUrl,

        downloadUrl:
          auth.downloadUrl,

        message:
          "Backblaze B2 authorization and bucket configuration are working."
      });
    } catch (error) {
      console.error(
        "B2 STATUS ERROR:",
        error
      );

      return res.status(502).json({
        ok:
          false,

        ...b2ConfigStatus(),

        error:
          error.message ||
          "Backblaze B2 connection failed."
      });
    }
  }
);

// ============================================================
// ADMIN APPS
// ============================================================

app.get(
  "/api/admin/apps",
  requireAdmin,
  async (req, res) => {
    try {
      const apps =
        await AppModel.find()
          .sort({
            createdAt:
              -1
          })
          .lean();

      res.json(apps);
    } catch {
      res.status(500).json({
        error:
          "Unable to load admin apps"
      });
    }
  }
);

// ============================================================
// CREATE APP
// ============================================================

app.post(
  "/api/admin/apps",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        normalizeAppBody(
          req.body
        );

      if (!body.name) {
        return res.status(400).json({
          error:
            "App name is required"
        });
      }

      if (
        !validHttpUrl(
          body.websiteUrl
        ) ||
        !validHttpUrl(
          body.downloadUrl
        )
      ) {
        return res.status(400).json({
          error:
            "Website/download URL must be http(s)"
        });
      }

      const item =
        await AppModel.create(
          body
        );

      res.status(201).json(
        item
      );
    } catch (error) {
      console.error(error);

      res.status(400).json({
        error:
          error.message ||
          "Could not create app"
      });
    }
  }
);

// ============================================================
// UPDATE APP
// ============================================================

app.put(
  "/api/admin/apps/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const body =
        normalizeAppBody(
          req.body
        );

      if (
        !validHttpUrl(
          body.websiteUrl
        ) ||
        !validHttpUrl(
          body.downloadUrl
        )
      ) {
        return res.status(400).json({
          error:
            "Website/download URL must be http(s)"
        });
      }

      const item =
        await AppModel.findByIdAndUpdate(
          req.params.id,
          body,
          {
            new:
              true,

            runValidators:
              true
          }
        );

      if (!item) {
        return res.status(404).json({
          error:
            "App not found"
        });
      }

      res.json(item);
    } catch (error) {
      res.status(400).json({
        error:
          error.message ||
          "Could not update app"
      });
    }
  }
);

// ============================================================
// DELETE APP
// ============================================================

app.delete(
  "/api/admin/apps/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await AppModel.findByIdAndDelete(
        req.params.id
      );

      await Access.deleteMany({
        appId:
          req.params.id
      });

      res.json({
        success:
          true
      });
    } catch {
      res.status(400).json({
        error:
          "Could not delete app"
      });
    }
  }
);

// ============================================================
// B2 UPLOAD
// ============================================================

const uploadAll =
  multer({
    storage,

    limits: {
      fileSize:
        300 * 1024 * 1024
    },

    fileFilter:
      function (
        req,
        file,
        cb
      ) {
        const kind =
          String(
            req.body.kind ||
            ""
          );

        const imageOk =
          allowedImageTypes.includes(
            file.mimetype
          );

        const apkOk =
          file.mimetype ===
          "application/vnd.android.package-archive" ||
          /\.apk$/i.test(
            file.originalname
          );

        if (
          [
            "logo",
            "banner",
            "screenshot"
          ].includes(kind) &&
          !imageOk
        ) {
          return cb(
            new Error(
              "Only JPG, PNG, WEBP and GIF images are allowed."
            )
          );
        }

        if (
          kind === "apk" &&
          !apkOk
        ) {
          return cb(
            new Error(
              "Only APK files are allowed."
            )
          );
        }

        if (
          ![
            "logo",
            "banner",
            "screenshot",
            "apk"
          ].includes(kind)
        ) {
          return cb(
            new Error(
              "Invalid upload type."
            )
          );
        }

        cb(
          null,
          true
        );
      }
  });

app.post(
  "/api/admin/upload",
  requireAdmin,
  uploadAll.single("file"),
  async (req, res) => {
    let tempPath =
      "";

    try {
      if (!b2Configured()) {
        return res.status(503).json({
          error:
            "Backblaze B2 is not configured on the server."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error:
            "File is required."
        });
      }

      tempPath =
        req.file.path;

      const kind =
        String(
          req.body.kind ||
          "file"
        );

      const folder =
        kind === "apk"
          ? "apps"
          : `images/${kind}`;

      const fileName =
        `${folder}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${b2SafeName(req.file.originalname)}`;

      const uploaded =
        await b2UploadFile(
          tempPath,
          fileName,
          req.file.mimetype
        );

      res.json({
        success:
          true,

        kind,

        key:
          uploaded.fileName,

        url:
          `/api/media?key=${encodeURIComponent(
            uploaded.fileName
          )}`,

        fileName:
          req.file.originalname,

        mime:
          uploaded.contentType,

        size:
          uploaded.size
      });
    } catch (error) {
      console.error(
        "B2 UPLOAD ERROR:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Backblaze upload failed."
      });
    } finally {
      if (tempPath) {
        fs.promises
          .unlink(tempPath)
          .catch(
            () => { }
          );
      }
    }
  }
);

// ============================================================
// ADMIN ORDERS
// ============================================================

app.get(
  "/api/admin/orders",
  requireAdmin,
  async (req, res) => {
    try {
      const orders =
        await Order.find()
          .sort({
            createdAt:
              -1
          })
          .limit(500)
          .lean();

      res.json(
        orders
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load orders"
      });
    }
  }
);

// ============================================================
// ADMIN STATS
// ============================================================

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        apps,
        orders,
        paid
      ] =
        await Promise.all([
          AppModel.countDocuments(),

          Order.countDocuments(),

          Order.find({
            status:
              "paid"
          }).lean()
        ]);

      const revenue =
        paid.reduce(
          (
            sum,
            order
          ) =>
            sum +
            Number(
              order.amount ||
              0
            ),

          0
        );

      const downloads =
        await AppModel.aggregate([
          {
            $group: {
              _id:
                null,

              total: {
                $sum:
                  "$downloads"
              }
            }
          }
        ]);

      res.json({
        apps,

        orders,

        paidOrders:
          paid.length,

        revenue,

        downloads:
          downloads[0]
            ?.total ||
          0
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to load statistics"
      });
    }
  }
);

// ============================================================
// ADMIN CUSTOMERS
// ============================================================

app.get(
  "/api/admin/customers",
  requireAdmin,
  async (req, res) => {
    try {
      const customers =
        await Order.find()
          .select(
            "appName amount status customerName customerEmail customerPhone razorpayPaymentId createdAt"
          )
          .sort({
            createdAt:
              -1
          })
          .limit(500)
          .lean();

      res.json(
        customers
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load customers"
      });
    }
  }
);

// ============================================================
// ADMIN WEBSITE SETTINGS
// ============================================================

app.get(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const settings =
        await Settings.findOne({
          key:
            "main"
        }).lean();

      res.json(
        settings || {
          key:
            "main",

          title:
            "STUDY PREMIUM COURSE ",

          tagline:
            "LEARN • PREPARE • SUCCEED"
        }
      );
    } catch {
      res.status(500).json({
        error:
          "Unable to load website settings."
      });
    }
  }
);

app.put(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const title =
        String(
          req.body.title ||
          "STUDY PREMIUM COURSE "
        )
          .trim()
          .slice(
            0,
            100
          );

      const tagline =
        String(
          req.body.tagline ||
          "LEARN • PREPARE • SUCCEED"
        )
          .trim()
          .slice(
            0,
            180
          );

      const settings =
        await Settings.findOneAndUpdate(
          {
            key:
              "main"
          },

          {
            key:
              "main",

            title,

            tagline
          },

          {
            upsert:
              true,

            new:
              true,

            runValidators:
              true
          }
        ).lean();

      res.json(
        settings
      );
    } catch (error) {
      res.status(400).json({
        error:
          error.message ||
          "Could not save website settings."
      });
    }
  }
);

// ============================================================
// UPLOAD ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    if (
      err instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        error:
          `Upload error: ${err.message}`
      });
    }

    if (err) {
      console.error(
        err
      );

      return res.status(400).json({
        error:
          err.message ||
          "Request failed"
      });
    }

    next();
  }
);

// ============================================================
// STATIC
// ============================================================

app.use(
  "/uploads",
  express.static(
    uploadsDir,
    {
      maxAge:
        "1d"
    }
  )
);

app.use(
  express.static(
    publicDir,
    {
      extensions: [
        "html"
      ]
    }
  )
);

// ============================================================
// SPA FALLBACK
// ============================================================

app.get(
  "*splat",
  (
    req,
    res
  ) => {
    res.sendFile(
      path.join(
        publicDir,
        "index.html"
      )
    );
  }
);

// ============================================================
// INITIALIZATION
// ============================================================

async function ensureSettings() {
  await Settings.findOneAndUpdate(
    {
      key:
        "main"
    },

    {
      $setOnInsert: {
        key:
          "main",

        title:
          "STUDY PREMIUM COURSE",

        tagline:
          "LEARN • PREPARE • SUCCEED"
      }
    },

    {
      upsert:
        true
    }
  );
}

async function ensureAdmin() {
  const username =
    process.env.ADMIN_USERNAME;

  const password =
    process.env.ADMIN_PASSWORD;

  const secretKey =
    process.env.ADMIN_SECRET_KEY;

  if (
    !username ||
    !password ||
    !secretKey
  ) {
    console.warn(
      "WARNING: Admin environment variables are missing."
    );

    return;
  }

  const passwordHash =
    await bcrypt.hash(
      password,
      12
    );

  const secretHash =
    await bcrypt.hash(
      secretKey,
      12
    );

  await Admin.findOneAndUpdate(
    {
      username
    },

    {
      username,

      passwordHash,

      secretHash
    },

    {
      upsert:
        true,

      new:
        true
    }
  );

  console.log(
    `Admin account ready: ${username}`
  );
}

// ============================================================
// DEMO DATA
// ============================================================

async function ensureDemoApps() {
  if (
    await AppModel.countDocuments() >
    0
  ) {
    return;
  }

  await AppModel.insertMany([
    {
      name:
        "Study IQ",

      developer:
        "LALIT",

      category:
        "Education",

      description:
        "Competitive exam preparation, classes and study material.",

      logo:
        "https://placehold.co/256x256/111827/facc15?text=STUDY+IQ",

      screenshots: [
        "https://placehold.co/600x1000/0b0b0d/facc15?text=Course+Screen",

        "https://placehold.co/600x1000/0b0b0d/facc15?text=Course+Details",

        "https://placehold.co/600x1000/0b0b0d/facc15?text=Video+Player"
      ],

      banner:
        "https://placehold.co/1400x500/07111a/facc15?text=STUDY+IQ",

      price:
        0,

      websiteUrl:
        "https://example.com",

      downloadUrl:
        "https://example.com",

      accessType:
        "free",

      validity:
        "Lifetime",

      rating:
        4.8,

      downloads:
        23000,

      featured:
        true,

      trending:
        true,

      published:
        true
    },

    {
      name:
        "UP PCS Prelims 2026 - Pratigya Crash Course",

      developer:
        "Rojgar With Ankit",

      category:
        "UPSC/UPPCS",

      description:
        "Demo paid course listing for STUDY PREMIUM COURSE.",

      logo:
        "https://placehold.co/256x256/111827/facc15?text=UPPCS",

      screenshots: [
        "https://placehold.co/600x1000/0b0b0d/facc15?text=Batch+Screen"
      ],

      banner:
        "https://placehold.co/1400x700/08121d/facc15?text=UPPCS+2026",

      price:
        799,

      websiteUrl:
        "https://example.com",

      downloadUrl:
        "https://example.com",

      accessType:
        "paid",

      validity:
        "Lifetime",

      rating:
        4.9,

      downloads:
        0,

      featured:
        true,

      trending:
        true,

      published:
        true
    }
  ]);

  console.log(
    "Demo apps created."
  );
}

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    if (
      !process.env.MONGODB_URI
    ) {
      throw new Error(
        "MONGODB_URI is missing"
      );
    }

    await mongoose.connect(
      process.env.MONGODB_URI
    );

    console.log(
      "MongoDB connected"
    );

    await ensureAdmin();

    await ensureSettings();

    await ensureDemoApps();

    app.listen(
      PORT,
      () => {
        console.log(
          `STUDY PREMIUM COURSE running on port ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "Server startup failed:",
      error.message
    );

    process.exit(1);
  }
}

startServer();