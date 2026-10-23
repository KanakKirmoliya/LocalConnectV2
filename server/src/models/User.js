import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
      index: true,
    },
    passwordHash: {
      type: String,
      required: [true, "Password is required"],
    },
    area: {
      type: String,
      default: "",
      trim: true,
    },
    phone: {
      type: String,
      default: "",
      trim: true,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    isBanned: {
      type: Boolean,
      default: false,
      index: true,
    },
    banReason: {
      type: String,
      default: "",
      trim: true,
    },
    suspensionStatus: {
      type: String,
      enum: ["none", "temporary", "permanent"],
      default: "none",
      index: true,
    },
    suspendedUntil: {
      type: Date,
      default: null,
    },
    reportCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Method to verify candidate password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Method to check suspension status and auto-lift expired temporary suspensions
userSchema.methods.isSuspended = function () {
  if (!this.isBanned && this.suspensionStatus === "none") {
    return { suspended: false };
  }

  // Check if temporary suspension period has passed
  if (this.suspensionStatus === "temporary" && this.suspendedUntil) {
    if (new Date() >= new Date(this.suspendedUntil)) {
      // Auto-lift expired temporary suspension
      this.isBanned = false;
      this.suspensionStatus = "none";
      this.suspendedUntil = null;
      this.banReason = "";
      this.save().catch(() => {});
      return { suspended: false };
    }
    return {
      suspended: true,
      type: "temporary",
      until: this.suspendedUntil,
      reason: this.banReason || "Account temporarily suspended due to community fraud/misuse reports.",
    };
  }

  return {
    suspended: true,
    type: "permanent",
    until: null,
    reason: this.banReason || "Account permanently suspended by administration.",
  };
};

// Method to return safe public object
userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    phone: this.phone || "",
    area: this.area,
    role: this.role,
    isBanned: this.isBanned || false,
    banReason: this.banReason || "",
    suspensionStatus: this.suspensionStatus || "none",
    suspendedUntil: this.suspendedUntil || null,
    reportCount: this.reportCount || 0,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model("User", userSchema);
