import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

import express from "express";
import cors from "cors";
import { connectDB } from "./src/config/db.js";
import authRoutes from "./src/routes/authRoutes.js";
import listingRoutes from "./src/routes/listingRoutes.js";
import requestRoutes from "./src/routes/requestRoutes.js";
import uploadRoutes from "./src/routes/uploadRoutes.js";
import adminRoutes from "./src/routes/adminRoutes.js";
import reportRoutes from "./src/routes/reportRoutes.js";
import reviewRoutes from "./src/routes/reviewRoutes.js";
import { updateListing, deleteListing, confirmAvailability } from "./src/controllers/listingController.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import { requestLogger } from "./src/middleware/logger.js";
import { requireAuth, requireAdmin } from "./src/middleware/auth.js";
import { Listing } from "./src/models/Listing.js";
import { calculateHaversineDistanceKm, resolveLocalityCoordinates } from "./src/utils/geo.js";

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173,http://127.0.0.1:5173"))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true,
}));
app.use(express.json());
app.use(requestLogger);

// Serve persistent media uploads statically
app.use("/uploads", express.static(path.resolve(__dirname, "uploads")));

// Initialize MongoDB Atlas Connection
connectDB().catch((err) => {
  console.warn("⚠️  Server started without database connection:", err.message);
});

// Production Observability: Health check endpoint
app.get("/api/v1/health", (req, res) => {
  const isDbConnected = Listing.db?.readyState === 1;
  const memory = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  const health = {
    success: isDbConnected,
    status: isDbConnected ? "ok" : "degraded",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    database: {
      status: isDbConnected ? "connected" : "disconnected",
      cluster: "MongoDB Atlas M0",
    },
    system: {
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
    },
  };

  res.status(isDbConnected ? 200 : 503).json(health);
});

// Modern Mobile API v1 Routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/listings", listingRoutes);
app.use("/api/v1/requests", requestRoutes);
app.use("/api/v1/upload", uploadRoutes);
app.use("/api/v1/reviews", reviewRoutes);

// -------------------------------------------------------------
// Real MongoDB Routes for Web Client (No Demo Fallbacks)
// -------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/reviews", reviewRoutes);

// Flags (Admin only, returns pending community reports)
app.get("/api/flags", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { Report } = await import("./src/models/Report.js");
    const reports = await Report.find({ status: "pending" }).lean();
    res.json(reports);
  } catch (err) {
    next(err);
  }
});

// Web Client: GET /api/:resource (rooms | rentals | lostfound | services)
app.get("/api/:resource", async (req, res, next) => {
  const resource = req.params.resource;
  const typeMap = {
    rooms: "room",
    rentals: "vehicle",
    lostfound: "lost_found",
    services: "service",
    alerts: "alert",
  };

  const targetType = typeMap[resource];
  if (!targetType) {
    return res.status(404).json({ error: `Unknown resource '${resource}'` });
  }

  try {
    const userLat = req.query.lat ? parseFloat(req.query.lat) : null;
    const userLng = req.query.lng ? parseFloat(req.query.lng) : null;
    const radiusFilter = req.query.radius ? parseFloat(req.query.radius) : null;
    const searchQuery = req.query.search ? req.query.search.trim() : null;

    // Read ONLY from real MongoDB Atlas database with optional keyword/locality search
    const query = { type: targetType, status: "active" };
    if (searchQuery) {
      const reg = new RegExp(searchQuery, "i");
      query.$or = [
        { title: reg },
        { description: reg },
        { locality: reg },
        { "lostFoundDetails.itemName": reg },
        { "lostFoundDetails.description": reg },
        { "lostFoundDetails.where": reg },
      ];
    }

    const items = await Listing.find(query).sort({ createdAt: -1 });

    const webFormatted = items.map((item) => {
      // Calculate real spherical distance using Haversine formula only when authentic coordinates are provided
      let calculatedKm = null;
      const isLegacyDefaultLocation =
        (item.latitude === 28.6139 && item.longitude === 77.209) ||
        (item.location?.coordinates?.[0] === 77.209 && item.location?.coordinates?.[1] === 28.6139);
      const itemLat = isLegacyDefaultLocation ? null : (item.latitude ?? item.location?.coordinates?.[1] ?? null);
      const itemLng = isLegacyDefaultLocation ? null : (item.longitude ?? item.location?.coordinates?.[0] ?? null);

      if (userLat != null && userLng != null && itemLat != null && itemLng != null) {
        calculatedKm = calculateHaversineDistanceKm(userLat, userLng, itemLat, itemLng);
      }

      const rawItem = item.toObject();
      delete rawItem.ownerPhone;
      const publicLatitude = itemLat == null || isLegacyDefaultLocation ? null : Number(itemLat.toFixed(2));
      const publicLongitude = itemLng == null || isLegacyDefaultLocation ? null : Number(itemLng.toFixed(2));

      const base = {
        ...rawItem,
        id: item._id.toString(),
        _id: item._id.toString(),
        title: item.title,
        description: item.description,
        locality: item.locality,
        latitude: publicLatitude,
        longitude: publicLongitude,
        location: publicLatitude == null || publicLongitude == null
          ? null
          : { type: "Point", coordinates: [publicLongitude, publicLatitude] },
        photos: item.photos || [],
        videos: item.videos || [],
        ownerId: item.ownerId.toString(),
        owner: item.ownerName,
        km: calculatedKm,
        ang: 45,
        averageRating: item.averageRating || 0,
        reviewsCount: item.reviewsCount || 0,
      };

      if (targetType === "room") {
        base.rent = item.roomDetails?.rent || 0;
        base.deposit = item.roomDetails?.deposit || 0;
        base.maintenance = item.roomDetails?.maintenance || 0;
        base.roomType = item.roomDetails?.roomType || "Single";
        base.availableFrom = item.roomDetails?.availableFrom || null;
        base.amenities = item.roomDetails?.amenities || [];
        base.verified = item.roomDetails?.verified || false;
        base.availabilityConfirmedAt = item.roomDetails?.availabilityConfirmedAt || item.updatedAt || item.createdAt;
        base.averageRating = item.averageRating || 0;
        base.reviewsCount = item.reviewsCount || 0;
      } else if (targetType === "vehicle") {
        base.name = item.title;
        base.type = item.vehicleDetails?.vehicleType || "Bike";
        base.rate = item.vehicleDetails?.rentalPrice || 0;
        base.available = item.vehicleDetails?.available ?? true;
        base.averageRating = item.averageRating || 0;
        base.reviewsCount = item.reviewsCount || 0;
      } else if (targetType === "lost_found") {
        base.kind = item.lostFoundDetails?.kind || "found";
        base.category = item.lostFoundDetails?.category || "Other";
        base.itemName = item.lostFoundDetails?.itemName || item.title;
        base.description = item.lostFoundDetails?.description || item.description || "";
        base.where = item.lostFoundDetails?.where || item.locality;
        base.by = item.ownerName;
        base.contactPhone = item.lostFoundDetails?.contactPhone || item.ownerPhone || "";
        base.reward = item.lostFoundDetails?.reward || "";
        base.isUrgent = Boolean(item.lostFoundDetails?.isUrgent);
        base.incidentDate = item.lostFoundDetails?.incidentDate || item.createdAt;
        base.minsAgo = Math.max(1, Math.round((Date.now() - new Date(item.createdAt).getTime()) / 60000));
      } else if (targetType === "service") {
        base.name = item.title;
        base.trade = item.serviceDetails?.serviceCategory || "Other";
        base.rating = item.averageRating > 0 ? item.averageRating : (item.serviceDetails?.rating || 5.0);
        base.jobs = item.reviewsCount > 0 ? item.reviewsCount : (item.serviceDetails?.jobsCount || 0);
        base.averageRating = item.averageRating > 0 ? item.averageRating : (item.serviceDetails?.rating || 5.0);
        base.reviewsCount = item.reviewsCount || (item.serviceDetails?.jobsCount || 0);
        base.price = item.serviceDetails?.pricingInfo || "";
        base.available = item.serviceDetails?.available ?? true;
      } else if (targetType === "alert") {
        base.type = item.alertDetails?.alertType || "Stuck";
        base.helpers = item.alertDetails?.helpersCount || 0;
        base.minsAgo = Math.max(1, Math.round((Date.now() - new Date(item.createdAt).getTime()) / 60000));
        base.by = item.ownerName;
      }

      return base;
    });

    const shouldFilterDistance = radiusFilter != null && radiusFilter < 9999 && !searchQuery;
    const filtered = shouldFilterDistance
      ? webFormatted.filter((item) => item.km == null || item.km <= radiusFilter)
      : webFormatted;

    return res.json(filtered);
  } catch (err) {
    next(err);
  }
});

// Web Client: POST /api/:resource (rooms | rentals | lostfound | services)
// Authenticated user creates a persistent listing in MongoDB Atlas
app.post("/api/:resource", requireAuth, async (req, res, next) => {
  if (req.userRole === "admin") {
    return res.status(403).json({
      error: "Master Admin accounts cannot post consumer marketplace listings. Use a regular user account.",
    });
  }

  const resource = req.params.resource;
  const typeMap = {
    rooms: "room",
    rentals: "vehicle",
    lostfound: "lost_found",
    services: "service",
    alerts: "alert",
  };

  const targetType = typeMap[resource];
  if (!targetType) {
    return res.status(404).json({ error: `Cannot post to unknown resource '${resource}'` });
  }

  try {
    const body = req.body || {};
    let lat = typeof body.latitude === "number" ? body.latitude : (body.latitude ? parseFloat(body.latitude) : null);
    let lng = typeof body.longitude === "number" ? body.longitude : (body.longitude ? parseFloat(body.longitude) : null);

    // If coordinates were omitted, automatically resolve using local registry
    if (lat == null || lng == null) {
      const placeText = body.locality || body.where || req.user?.area || "";
      const resolved = resolveLocalityCoordinates(placeText);
      if (resolved) {
        lat = resolved.lat;
        lng = resolved.lng;
      }
    }

    const listingPayload = {
      ownerId: req.userId,
      ownerName: req.userName,
      ownerPhone: req.user?.phone || body.phone || body.contactPhone || "",
      type: targetType,
      title: body.title || body.name || body.itemName || "Untitled Listing",
      description: body.description || "",
      locality: body.locality || body.where || req.user?.area || "Local Area",
      latitude: lat,
      longitude: lng,
      status: "active",
      photos: Array.isArray(body.photos) ? body.photos : [],
      videos: Array.isArray(body.videos) ? body.videos : [],
    };

    if (lat != null && lng != null) {
      listingPayload.location = {
        type: "Point",
        coordinates: [lng, lat],
      };
    }

    if (targetType === "room") {
      listingPayload.roomDetails = {
        rent: Number(body.rent) || 0,
        deposit: Number(body.deposit) || 0,
        maintenance: Number(body.maintenance) || 0,
        roomType: body.roomType || "Single",
        period: body.period || "month",
        amenities: Array.isArray(body.amenities) ? body.amenities : ["WiFi"],
        verified: false,
        availableFrom: body.availableFrom || null,
        availabilityConfirmedAt: new Date(),
      };
    } else if (targetType === "vehicle") {
      listingPayload.vehicleDetails = {
        vehicleType: body.type || body.vehicleType || "Bike",
        rentalPrice: Number(body.rate || body.rentalPrice) || 0,
        pricingPeriod: "hour",
        available: true,
      };
    } else if (targetType === "lost_found") {
      const isUrgent = Boolean(body.isUrgent || body.urgent);
      listingPayload.lostFoundDetails = {
        kind: body.kind === "lost" ? "lost" : "found",
        category: body.category || "Other",
        itemName: body.title || body.itemName || "",
        description: body.description || "",
        where: body.where || body.locality || req.user?.area || "",
        incidentDate: body.incidentDate ? new Date(body.incidentDate) : new Date(),
        contactPhone: body.contactPhone || req.user?.phone || "",
        reward: body.reward || "",
        isUrgent,
      };
    } else if (targetType === "service") {
      listingPayload.serviceDetails = {
        serviceCategory: body.trade || body.serviceCategory || "Other",
        pricingInfo: body.price || body.pricingInfo || "Contact for quote",
        rating: 5.0,
        jobsCount: 0,
        available: true,
      };
    } else if (targetType === "alert") {
      listingPayload.alertDetails = {
        alertType: body.type || body.alertType || "Stuck",
        helpersCount: 0,
      };
    }

    const created = await Listing.create(listingPayload);
    console.log(`✅ [MongoDB Atlas] New ${targetType} listing persisted: "${created.title}" at (${lat}, ${lng}) by ${req.userName}`);

    // Auto-broadcast Emergency Alert to Locality if an urgent lost item was reported
    if (targetType === "lost_found" && created.lostFoundDetails?.isUrgent) {
      try {
        const alertPayload = {
          ownerId: req.userId,
          ownerName: req.userName,
          ownerPhone: body.contactPhone || req.user?.phone || "",
          type: "alert",
          title: `🚨 URGENT LOST ITEM: ${created.title} (${created.locality})`,
          description: `Urgent lost item report: ${created.description || created.title}. Locality: ${created.locality}. Contact: ${body.contactPhone || req.user?.phone || req.user?.email || "Chat in app"}${body.reward ? ` · Reward: ${body.reward}` : ""}`,
          locality: created.locality,
          latitude: created.latitude,
          longitude: created.longitude,
          status: "active",
          photos: created.photos || [],
          alertDetails: {
            alertType: "Safety",
            helpersCount: 0,
          },
        };
        if (created.latitude != null && created.longitude != null) {
          alertPayload.location = {
            type: "Point",
            coordinates: [created.longitude, created.latitude],
          };
        }
        const broadcastAlert = await Listing.create(alertPayload);
        created.lostFoundDetails.alertBroadcastId = broadcastAlert._id;
        await created.save();
        console.log(`🚨 [Emergency Broadcast] Published locality alert for urgent lost item "${created.title}" in ${created.locality}`);
      } catch (alertErr) {
        console.warn("Could not create linked urgent broadcast alert:", alertErr.message);
      }
    }

    // Return format expected by web client
    const webItem = {
      id: created._id.toString(),
      _id: created._id.toString(),
      title: created.title,
      owner: created.ownerName,
      ownerId: created.ownerId.toString(),
      locality: created.locality,
      latitude: created.latitude == null ? null : Number(created.latitude.toFixed(2)),
      longitude: created.longitude == null ? null : Number(created.longitude.toFixed(2)),
      location: created.latitude == null || created.longitude == null
        ? null
        : { type: "Point", coordinates: [Number(created.longitude.toFixed(2)), Number(created.latitude.toFixed(2))] },
      photos: created.photos,
      videos: created.videos,
      km: null,
      ang: 30,
      rent: created.roomDetails?.rent,
      deposit: created.roomDetails?.deposit || 0,
      maintenance: created.roomDetails?.maintenance || 0,
      roomType: created.roomDetails?.roomType || "Single",
      availableFrom: created.roomDetails?.availableFrom || null,
      availabilityConfirmedAt: created.roomDetails?.availabilityConfirmedAt || created.createdAt,
      amenities: created.roomDetails?.amenities,
      verified: created.roomDetails?.verified,
      name: created.title,
      type: created.vehicleDetails?.vehicleType || created.alertDetails?.alertType,
      rate: created.vehicleDetails?.rentalPrice,
      available: created.vehicleDetails?.available,
      kind: created.lostFoundDetails?.kind,
      category: created.lostFoundDetails?.category,
      itemName: created.lostFoundDetails?.itemName,
      description: created.lostFoundDetails?.description || created.description,
      where: created.lostFoundDetails?.where || created.locality,
      by: created.ownerName,
      contactPhone: created.lostFoundDetails?.contactPhone || created.ownerPhone,
      reward: created.lostFoundDetails?.reward,
      isUrgent: created.lostFoundDetails?.isUrgent,
      incidentDate: created.lostFoundDetails?.incidentDate || created.createdAt,
      trade: created.serviceDetails?.serviceCategory,
      price: created.serviceDetails?.pricingInfo,
      rating: created.serviceDetails?.rating || 5.0,
      jobs: created.serviceDetails?.jobsCount || 0,
      averageRating: created.averageRating || 0,
      reviewsCount: created.reviewsCount || 0,
      helpers: created.alertDetails?.helpersCount || 0,
      minsAgo: 1,
    };

    return res.status(201).json(webItem);
  } catch (err) {
    next(err);
  }
});

// Web Client: PATCH & DELETE listing routes (Owner / Admin protected)
app.patch("/api/:resource/:id", requireAuth, updateListing);
app.patch("/api/:resource/:id/availability", requireAuth, confirmAvailability);
app.delete("/api/:resource/:id", requireAuth, deleteListing);

// Centralized error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
export const server = app.listen(PORT, () => {
  console.log(`🚀 NearNest API Server listening on port ${PORT}`);
});

export default app;
