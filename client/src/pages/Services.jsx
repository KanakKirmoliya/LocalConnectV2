import { useState } from "react";
import { Star, Plus, Trash2, CheckCircle2, Flag } from "lucide-react";
import { Empty, Field, Modal, PageHead } from "../components/ui.jsx";
import ReportModal from "../components/ReportModal.jsx";
import ReviewsModal from "../components/ReviewsModal.jsx";
import { useResource, useStore } from "../store.jsx";
import { post, del } from "../api.js";

const TRADES = ["All", "Electrician", "Mechanic", "Plumber", "Notes", "Other"];

export default function Services() {
  const { radius, setRadius, notify, user, userLocation } = useStore();
  const [services, setServices] = useResource("services");
  const [trade, setTrade] = useState("All");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [reviewingService, setReviewingService] = useState(null);
  const [reportingService, setReportingService] = useState(null);

  const list = services.filter(
    (s) =>
      (radius >= 9999 || s.km == null || s.km <= radius) &&
      (trade === "All" || s.trade === trade) &&
      (s.name || "").toLowerCase().includes(q.toLowerCase())
  );

  const handleReviewUpdated = (serviceId, stats) => {
    setServices((prev) =>
      prev.map((item) =>
        (item.id === serviceId || item._id === serviceId)
          ? {
              ...item,
              averageRating: stats.averageRating,
              reviewsCount: stats.totalReviews,
              rating: stats.averageRating,
              jobs: stats.totalReviews,
            }
          : item
      )
    );
  };

  const addService = async (form) => {
    try {
      const item = await post("services", {
        name: form.name,
        trade: form.trade,
        price: form.price,
        locality: form.locality || userLocation?.area || user?.area || "Local Area",
        latitude: form.latitude || userLocation?.lat,
        longitude: form.longitude || userLocation?.lng,
        available: true,
      });
      setServices((prev) => [item, ...prev]);
      setAdding(false);
      notify("Service listed successfully. Visible to locals nearby.");
    } catch (err) {
      notify(err.message || "Failed to list service.");
    }
  };

  const deleteService = async (id) => {
    if (!window.confirm("Are you sure you want to remove this service?")) return;
    try {
      await del("services", id);
      setServices((prev) => prev.filter((s) => (s.id || s._id) !== id));
      notify("Service removed from database.");
    } catch (err) {
      notify(err.message || "Failed to remove service.");
    }
  };

  const handleBook = async (s) => {
    try {
      await post("requests", {
        listingId: s.id || s._id,
        message: `Booking inquiry for ${s.name} (${s.trade}).`,
      });
      notify(`${s.trade === "Notes" ? "Request" : "Booking request"} sent to ${s.name}.`);
    } catch (err) {
      notify(err.message || "Failed to send booking request.");
    }
  };

  return (
    <>
      <PageHead
        title="Local services"
        sub="Electricians, mechanics, plumbers, tutors, and study notes from verified locals."
        action={<button className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Offer a service</button>}
      />
      <input className="search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" />
      <div className="chips big" role="group" aria-label="Filter services by trade">
        {TRADES.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip ${trade === t ? "on" : ""}`}
            aria-pressed={trade === t}
            onClick={() => setTrade(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="list">
        {list.length === 0 && <Empty text="No matches. Try another trade, widen the radius, or offer your own service!" />}
        {list.map((s) => {
          const sId = s.id || s._id;
          const isOwner = user && (s.ownerId === user.id || s.owner === user.name);
          return (
            <article key={sId} className="card">
              <div className="card-top">
                <h3>{s.name}</h3>
                <strong className="price">{s.price}</strong>
              </div>
              <p className="meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span>{s.trade} {s.km != null ? `· ${s.km} km away` : ""}</span>
                <span>·</span>
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    fontWeight: 700,
                    color: "#D97706",
                    fontSize: "0.85rem",
                  }}
                  onClick={() => setReviewingService(s)}
                  title="Click to view and add ratings & reviews"
                >
                  <Star size={13} className="star" /> {s.averageRating > 0 ? Number(s.averageRating).toFixed(1) : (s.rating || 5.0)}
                  <span style={{ fontWeight: 400, color: "var(--mute)", marginLeft: 2 }}>
                    ({s.reviewsCount != null ? s.reviewsCount : (s.jobs || 0)} {s.trade === "Notes" ? "buyers" : "reviews"})
                  </span>
                </button>
              </p>
              <div className="card-actions">
                <button
                  className="btn"
                  style={{ padding: "4px 8px", fontSize: "0.75rem", borderColor: "#FDE68A", background: "#FFFBEB", color: "#92400E" }}
                  onClick={() => setReviewingService(s)}
                  title="View ratings breakdown and post a review"
                >
                  <Star size={12} style={{ marginRight: 3, fill: "#F59E0B", color: "#F59E0B" }} />
                  Reviews ({s.reviewsCount != null ? s.reviewsCount : (s.jobs || 0)})
                </button>

                {!isOwner && (
                  <button
                    className="btn"
                    style={{ padding: "4px 8px", fontSize: "0.75rem", color: "var(--mute)", borderColor: "var(--line)" }}
                    title="Report this service or provider for fraud / misuse"
                    onClick={() => setReportingService(s)}
                  >
                    <Flag size={12} style={{ marginRight: 3 }} /> Report
                  </button>
                )}

                {isOwner ? (
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", marginLeft: "auto" }}>
                    <span className="status ok"><CheckCircle2 size={13} style={{ marginRight: 4 }} /> Your service</span>
                    <button className="btn" style={{ borderColor: "#ef4444", color: "#ef4444" }} onClick={() => deleteService(sId)}>
                      <Trash2 size={13} style={{ marginRight: 4 }} /> Delete
                    </button>
                  </div>
                ) : s.available ? (
                  <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => handleBook(s)}>
                    {s.trade === "Notes" ? "Get notes" : "Book"}
                  </button>
                ) : (
                  <span className="status bad" style={{ marginLeft: "auto" }}>Busy today</span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {adding && (
        <AddService
          onClose={() => setAdding(false)}
          onSave={addService}
          defaultLocality={user?.area}
        />
      )}

      {reviewingService && (
        <ReviewsModal
          listing={reviewingService}
          onClose={() => setReviewingService(null)}
          onReviewUpdated={(stats) => handleReviewUpdated(reviewingService.id || reviewingService._id, stats)}
        />
      )}

      {reportingService && (
        <ReportModal
          target={reportingService}
          targetType="listing"
          onClose={() => setReportingService(null)}
        />
      )}
    </>
  );
}

function AddService({ onClose, onSave, defaultLocality }) {
  const [form, setForm] = useState({ name: "", trade: "Electrician", price: "Rs 200 visit", locality: defaultLocality || "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal title="Offer a service" onClose={onClose}>
      <Field label="Service / Provider Name">
        <input value={form.name} onChange={set("name")} placeholder="e.g. Ramesh Electrical Works / B.Tech Notes" />
      </Field>
      <Field label="Trade Category">
        <select value={form.trade} onChange={set("trade")}>
          <option value="Electrician">Electrician</option>
          <option value="Mechanic">Mechanic</option>
          <option value="Plumber">Plumber</option>
          <option value="Notes">Notes</option>
          <option value="Other">Other</option>
        </select>
      </Field>
      <Field label="Pricing Info">
        <input value={form.price} onChange={set("price")} placeholder="e.g. Rs 200 visit charge / Rs 100 PDF" />
      </Field>
      <Field label="Locality / Area">
        <input value={form.locality} onChange={set("locality")} placeholder="e.g. Sector 15" />
      </Field>
      <button className="btn primary wide" disabled={!form.name || !form.price} onClick={() => onSave(form)}>
        Publish service to database
      </button>
    </Modal>
  );
}
