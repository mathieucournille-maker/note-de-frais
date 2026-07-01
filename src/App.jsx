// ─── note-de-frais.jsx ───────────────────────────────────────────────────────
// PWA iPhone — Note de frais professionnelle
// Mathieu COURNILLE
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback } from "react";

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

// Clé ORS gratuite — créez la vôtre sur https://openrouteservice.org/dev/#/signup
const ORS_API_KEY = "5b3ce3597851110001cf6248a82891fb8b2f45b0b8f1e8f2c4f3e7f0";

const DEFAULT_NOM   = "Mathieu COURNILLE";
const DEFAULT_EMAIL = "sandrine.lecorgne@83095.notaires.fr"; // conservé pour usage futur

// ══════════════════════════════════════════════════════════════════════════════
// COUCHE STOCKAGE — localStorage avec interface générique (migration IndexedDB facile)
// ══════════════════════════════════════════════════════════════════════════════

const Storage = {
  _key: "notes_frais_v2",
  load() {
    try { return JSON.parse(localStorage.getItem(this._key)) ?? []; }
    catch { return []; }
  },
  save(notes) {
    try { localStorage.setItem(this._key, JSON.stringify(notes)); }
    catch (e) { console.error("[Storage] Erreur écriture :", e); }
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// BARÈME KILOMÉTRIQUE URSSAF / DGFiP 2026
// ══════════════════════════════════════════════════════════════════════════════

const BAREME = {
  "3": { t1: 0.529, a2: 0.316, b2: 1065, t3: 0.370 },
  "4": { t1: 0.606, a2: 0.340, b2: 1330, t3: 0.407 },
  "5": { t1: 0.636, a2: 0.357, b2: 1395, t3: 0.427 },
  "6": { t1: 0.665, a2: 0.374, b2: 1457, t3: 0.447 },
  "7": { t1: 0.697, a2: 0.394, b2: 1515, t3: 0.470 },
};

function calcIK(cv, km, electrique, kmCumules = 0) {
  const k = Math.min(Math.max(parseInt(cv), 3), 7).toString();
  const b = BAREME[k];
  const d = parseFloat(km) || 0;
  const total = (parseFloat(kmCumules) || 0) + d;
  let ik = total <= 5000  ? d * b.t1
         : total <= 20000 ? d * b.a2 + b.b2
         : d * b.t3;
  return electrique ? ik * 1.2 : ik;
}

const fmt      = (n) => `${(parseFloat(n) || 0).toFixed(2)} €`;
const fmtShort = (n) => `${(parseFloat(n) || 0).toFixed(0)} €`;

// ══════════════════════════════════════════════════════════════════════════════
// COMPRESSION PHOTO — canvas → toBlob JPEG (low memory Safari)
// ══════════════════════════════════════════════════════════════════════════════

async function compressImage(file, maxTotalKB = 950, count = 1) {
  const maxKB = Math.max(80, Math.floor(maxTotalKB / Math.max(count, 1)));
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const canvas = document.createElement("canvas");
      let { naturalWidth: w, naturalHeight: h } = img;
      const MAX = 1400;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h / w * MAX); w = MAX; }
        else       { w = Math.round(w / h * MAX); h = MAX; }
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);

      const step = (q) => canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("Compression échouée"));
        if (blob.size / 1024 > maxKB && q > 0.25) return step(+(q - 0.08).toFixed(2));
        const fr = new FileReader();
        fr.onload  = (e) => resolve(e.target.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      }, "image/jpeg", q);
      step(0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error("Lecture image échouée")); };
    img.src = blobUrl;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// DISTANCE — OpenRouteService (géocodage + itinéraire)
// Accepte : adresse complète, ville, code postal, nom d'entreprise
// ══════════════════════════════════════════════════════════════════════════════

async function orsGeocode(query) {
  const url = `https://api.openrouteservice.org/geocode/search`
            + `?api_key=${ORS_API_KEY}`
            + `&text=${encodeURIComponent(query)}`
            + `&lang=fr&size=1&boundary.country=FR`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Géocodage HTTP ${r.status}`);
  const d = await r.json();
  if (!d.features?.length)
    throw new Error(`Lieu introuvable : "${query}". Essayez avec la ville ou le code postal.`);
  const [lon, lat] = d.features[0].geometry.coordinates;
  return { lat, lon };
}

async function getDistance(depart, destination) {
  const [o, dst] = await Promise.all([
    orsGeocode(depart),
    orsGeocode(destination),
  ]).catch(() => {
    throw new Error("Impossible de localiser les adresses. Vérifiez votre connexion.");
  });
  const url = `https://api.openrouteservice.org/v2/directions/driving-car`
            + `?api_key=${ORS_API_KEY}`
            + `&start=${o.lon},${o.lat}&end=${dst.lon},${dst.lat}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Itinéraire HTTP ${r.status}`);
  const d = await r.json();
  if (!d.features?.length)
    throw new Error("Aucun itinéraire trouvé entre ces deux adresses.");
  const oneWayM = d.features[0].properties.segments[0].distance;
  return Math.round(oneWayM / 1000 * 2); // aller-retour
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF — chargement jsPDF via CDN UMD (compatible Artifact Claude)
// Rendu identique à la version précédente — optimisé Safari iOS
// ══════════════════════════════════════════════════════════════════════════════

let _jsPDFClass = null;
async function getJsPDF() {
  if (_jsPDFClass) return _jsPDFClass;
  if (!window.jspdf?.jsPDF) {
    await new Promise((res, rej) => {
      if (document.getElementById("jspdf-script")) { res(); return; }
      const s = document.createElement("script");
      s.id  = "jspdf-script";
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  _jsPDFClass = window.jspdf.jsPDF;
  return _jsPDFClass;
}

function loadImageEl(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function buildPDF(note) {
  const JsPDF = await getJsPDF();
  const doc   = new JsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const PW = 210, PH = 297, ML = 18, MR = 18, CW = PW - ML - MR;
  let y = 0;

  // ── En-tête page 1 ─────────────────────────────────────────────────────────
  doc.setFillColor(27, 42, 74);
  doc.rect(0, 0, PW, 52, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(255, 255, 255);
  doc.text("NOTE DE FRAIS", ML, 20);
  doc.setFontSize(11); doc.setFont("helvetica", "normal"); doc.setTextColor(200, 210, 230);
  doc.text(note.nom, ML, 30);
  doc.text(`${note.date}  ·  ${note.depart} → ${note.destination}`, ML, 37);
  if (note.motif) doc.text(`Motif : ${note.motif}`, ML, 44);
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(150, 200, 190);
  doc.text("TOTAL À REMBOURSER", PW - MR, 26, { align: "right" });
  doc.setFontSize(18); doc.setTextColor(0, 201, 167);
  doc.text(fmt(note.grandTotal), PW - MR, 36, { align: "right" });
  y = 62;

  // ── Tableau de détail ──────────────────────────────────────────────────────
  const lignes = [
    { label: "Indemnités kilométriques",
      detail: `${note.km} km · ${note.cv} CV · Barème URSSAF 2026${note.electrique ? " · Électrique +20%" : ""}`,
      montant: note.ikMontant },
    note.peage   > 0 && { label: "Péages",        detail: "", montant: note.peage },
    note.parking > 0 && { label: "Stationnement", detail: "", montant: note.parking },
    ...note.repas.map(r   => ({ label: "Restaurant",    detail: r.libelle,  montant: parseFloat(r.montant) })),
    ...note.cadeaux.map(c => ({ label: "Cadeau client", detail: c.libelle, montant: parseFloat(c.montant) })),
  ].filter(Boolean);

  doc.setFillColor(238, 242, 253);
  doc.rect(ML, y - 5, CW, 9, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(46, 92, 230);
  doc.text("NATURE DE LA DÉPENSE", ML + 2, y);
  doc.text("MONTANT", PW - MR - 2, y, { align: "right" });
  y += 6;

  lignes.forEach((l, i) => {
    const rowH = l.detail ? 11 : 8;
    if (i % 2 === 0) { doc.setFillColor(250, 251, 254); doc.rect(ML, y - 5, CW, rowH, "F"); }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(27, 42, 74);
    doc.text(l.label, ML + 2, y);
    doc.setTextColor(46, 92, 230);
    doc.text(fmt(l.montant), PW - MR - 2, y, { align: "right" });
    if (l.detail) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(138, 147, 168);
      doc.text(l.detail, ML + 2, y + 4.5);
    }
    doc.setDrawColor(228, 232, 240); doc.setLineWidth(0.2);
    doc.line(ML, y + rowH - 4, PW - MR, y + rowH - 4);
    y += rowH;
  });

  y += 6;
  doc.setFillColor(0, 201, 167);
  doc.roundedRect(ML, y, CW, 14, 3, 3, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(255, 255, 255);
  doc.text("TOTAL À REMBOURSER", ML + 4, y + 9);
  doc.setFontSize(13);
  doc.text(fmt(note.grandTotal), PW - MR - 4, y + 9, { align: "right" });
  y += 22;

  // Pied de page
  doc.setFont("helvetica", "italic"); doc.setFontSize(7.5); doc.setTextColor(180, 185, 200);
  doc.text("Calcul basé sur le barème officiel URSSAF / DGFiP 2026 (arrêté du 27 mars 2023).", ML, PH - 10);
  doc.setFont("helvetica", "normal");
  doc.text(`Généré le ${new Date().toLocaleDateString("fr-FR")}`, PW - MR, PH - 10, { align: "right" });

  // ── Pages justificatifs ────────────────────────────────────────────────────
  for (let i = 0; i < (note.photos?.length ?? 0); i++) {
    doc.addPage();
    doc.setFillColor(27, 42, 74); doc.rect(0, 0, PW, 18, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    doc.text(`NOTE DE FRAIS · ${note.nom} · ${note.date}`, ML, 11);
    doc.setTextColor(0, 201, 167);
    doc.text(`JUSTIFICATIF ${i + 1} / ${note.photos.length}`, PW - MR, 11, { align: "right" });
    try {
      const imgEl  = await loadImageEl(note.photos[i]);
      const maxW   = CW, maxH = PH - 34;
      const ratio  = Math.min(maxW / imgEl.naturalWidth, maxH / imgEl.naturalHeight);
      const dW     = imgEl.naturalWidth  * ratio;
      const dH     = imgEl.naturalHeight * ratio;
      doc.addImage(note.photos[i], "JPEG", ML + (CW - dW) / 2, 24, dW, dH, undefined, "FAST");
    } catch {
      doc.setFont("helvetica", "italic"); doc.setFontSize(10); doc.setTextColor(200, 0, 0);
      doc.text("Impossible de charger cette image.", ML, 40);
    }
    doc.setFont("helvetica", "italic"); doc.setFontSize(7.5); doc.setTextColor(180, 185, 200);
    doc.text(`Justificatif ${i + 1} / ${note.photos.length}`, PW / 2, PH - 8, { align: "center" });
  }

  // Retourne ArrayBuffer pour Blob iOS-safe
  return doc.output("arraybuffer");
}

// ── Partage ou affichage PDF ──────────────────────────────────────────────────
async function generateAndSharePDF(note, onStatus) {
  onStatus("generation");
  let buffer;
  try { buffer = await buildPDF(note); }
  catch (e) { onStatus("error", e.message); return; }

  const blob     = new Blob([buffer], { type: "application/pdf" });
  const fileName = `Note_frais_${note.nom.replace(/\s+/g, "_")}_${note.date}.pdf`;
  const file     = new File([blob], fileName, { type: "application/pdf" });

  // 1) Web Share API avec fichier PDF (iPhone Safari 15.1+)
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `Note de frais – ${note.nom}` });
      onStatus("shared");
      return;
    } catch (err) {
      if (err.name === "AbortError") { onStatus("idle"); return; }
      // Autre erreur → fallback onglet
    }
  }

  // 2) Fallback : ouvre le PDF dans Safari (bouton Partager iOS disponible)
  const blobUrl = URL.createObjectURL(blob);
  const tab = window.open(blobUrl, "_blank");
  if (!tab) {
    URL.revokeObjectURL(blobUrl);
    onStatus("blocked");
    return;
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  onStatus("opened");
}

// ══════════════════════════════════════════════════════════════════════════════
// DESIGN SYSTEM — inchangé
// ══════════════════════════════════════════════════════════════════════════════

const C = {
  bg: "#F7F8FC", card: "#FFFFFF", navy: "#1B2A4A",
  blue: "#2E5CE6", blueLight: "#EEF2FD",
  accent: "#00C9A7", accentLight: "#E6FAF7",
  danger: "#E84949", text: "#1B2A4A", muted: "#8A93A8", border: "#E4E8F0",
  orange: "#F59E0B", orangeLight: "#FEF3C7",
};

const S = {
  root: { fontFamily: "'Inter', system-ui, sans-serif", background: C.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto" },
  nav: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, background: C.card, borderTop: `1px solid ${C.border}`, display: "flex", zIndex: 200 },
  navBtn: (a) => ({ flex: 1, padding: "12px 0 10px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, color: a ? C.blue : C.muted }),
  navIcon: { fontSize: 22 },
  navLabel: (a) => ({ fontSize: 10, fontWeight: a ? 700 : 500 }),
  header: { background: `linear-gradient(135deg, ${C.navy} 0%, #2E4080 100%)`, color: "#fff", padding: "28px 20px 20px", position: "sticky", top: 0, zIndex: 100 },
  headerTitle: { fontSize: 20, fontWeight: 700, margin: 0 },
  headerSub: { fontSize: 12, opacity: 0.65, marginTop: 2 },
  stepBar: { display: "flex", gap: 6, marginTop: 14 },
  stepDot: (a, d) => ({ flex: 1, height: 4, borderRadius: 4, background: d ? C.accent : a ? "#fff" : "rgba(255,255,255,0.25)", transition: "background 0.3s" }),
  body: { padding: "16px 16px 100px" },
  card: { background: C.card, borderRadius: 16, padding: "18px", boxShadow: "0 2px 12px rgba(27,42,74,0.07)", marginBottom: 14 },
  secTitle: { fontSize: 12, fontWeight: 700, color: C.muted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 },
  label: { fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6, display: "block" },
  input: { width: "100%", padding: "12px 14px", borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 15, color: C.text, background: "#fff", outline: "none", boxSizing: "border-box" },
  row: { display: "flex", gap: 10 },
  toggle: (a) => ({ flex: 1, padding: "11px 8px", borderRadius: 10, background: a ? C.blueLight : C.bg, color: a ? C.blue : C.muted, fontWeight: a ? 700 : 500, fontSize: 13, cursor: "pointer", border: `1.5px solid ${a ? C.blue : C.border}` }),
  chip: (a) => ({ padding: "8px 14px", borderRadius: 20, background: a ? C.navy : C.bg, color: a ? "#fff" : C.muted, fontWeight: 600, fontSize: 13, cursor: "pointer", border: `1.5px solid ${a ? C.navy : C.border}` }),
  sumRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}` },
  btn: (v = "primary") => ({ width: "100%", padding: "14px", borderRadius: 12, border: v === "outline" ? `1.5px solid ${C.border}` : "none", background: v === "primary" ? C.blue : v === "success" ? C.accent : v === "danger" ? C.danger : C.bg, color: v === "outline" ? C.navy : "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }),
  photoThumb: { width: 70, height: 70, borderRadius: 10, objectFit: "cover", border: `2px solid ${C.border}` },
  photoGrid: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 },
  addPhoto: { width: 70, height: 70, borderRadius: 10, border: `2px dashed ${C.border}`, background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.muted, fontSize: 11, fontWeight: 600, gap: 3 },
  ikBadge: { background: C.blueLight, borderRadius: 10, padding: "10px 14px", marginTop: 10, fontSize: 13, color: C.blue, fontWeight: 600 },
  statCard: (color = C.blue) => ({ background: C.card, borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(27,42,74,0.06)", borderLeft: `4px solid ${color}` }),
  statVal: { fontSize: 22, fontWeight: 800, color: C.navy },
  statLabel: { fontSize: 12, color: C.muted, marginTop: 2 },
  histItem: (r) => ({ background: C.card, borderRadius: 14, padding: "14px", marginBottom: 10, boxShadow: "0 1px 6px rgba(27,42,74,0.06)", borderLeft: `4px solid ${r ? C.accent : C.border}`, opacity: r ? 0.75 : 1 }),
};

const STEPS = ["Trajet", "Frais", "Récap", "PDF"];

// ══════════════════════════════════════════════════════════════════════════════
// COMPOSANT PDFButton — anti double-clic, tous statuts
// ══════════════════════════════════════════════════════════════════════════════

const PDF_LABELS = {
  idle:       "📄 Générer & Partager le PDF",
  generation: "⏳ Génération…",
  shared:     "✅ PDF partagé !",
  opened:     "✅ PDF ouvert dans Safari",
  blocked:    "⚠️ Autorisez les pop-ups Safari",
  error:      "❌ Erreur — réessayer",
};

function PDFButton({ note }) {
  const [status, setStatus] = useState("idle");
  const [errMsg, setErrMsg] = useState("");
  const busy = status === "generation";

  const handleStatus = useCallback((s, msg = "") => {
    setStatus(s); setErrMsg(msg);
    if (s === "shared" || s === "opened") setTimeout(() => setStatus("idle"), 4000);
    if (s === "error") setTimeout(() => setStatus("idle"), 5000);
  }, []);

  const handle = useCallback(async () => {
    if (busy) return;
    await generateAndSharePDF(note, handleStatus);
  }, [note, busy, handleStatus]);

  const variant = status === "error" || status === "blocked" ? "danger"
                : status === "shared" || status === "opened"  ? "success"
                : "primary";

  return (
    <>
      <button style={{ ...S.btn(variant), marginBottom: 8, opacity: busy ? 0.7 : 1 }}
        onClick={handle} disabled={busy}>
        {PDF_LABELS[status] ?? PDF_LABELS.idle}
      </button>
      {status === "error" && errMsg && (
        <div style={{ fontSize: 12, color: C.danger, marginBottom: 8, textAlign: "center" }}>{errMsg}</div>
      )}
      {status === "blocked" && (
        <div style={{ fontSize: 12, color: C.orange, marginBottom: 8, textAlign: "center" }}>
          Safari a bloqué l'ouverture. Allez dans Réglages → Safari → Bloquer les pop-ups → désactiver.
        </div>
      )}
      {(status === "idle" || status === "opened") && (
        <div style={{ fontSize: 11, color: C.muted, textAlign: "center", lineHeight: 1.6 }}>
          Sur iPhone : choisissez <strong>Mail</strong>, <strong>Teams</strong>, <strong>AirDrop</strong> ou <strong>Fichiers</strong>.
          {status === "opened" && <><br/>Le PDF est ouvert dans Safari → bouton Partager.</>}
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// APP ROOT
// ══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [tab, setTab]     = useState("dashboard");
  const [notes, setNotes] = useState(() => Storage.load());

  const saveAndRefresh = useCallback((updated) => {
    setNotes(updated);
    Storage.save(updated);
  }, []);

  // Enregistrement du service worker PWA
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return (
    <div style={S.root}>
      {tab === "dashboard"
        ? <Dashboard notes={notes} onSave={saveAndRefresh} onNew={() => setTab("new")} />
        : <NewNote
            onSaved={(note) => { saveAndRefresh([note, ...notes]); setTab("dashboard"); }}
            onCancel={() => setTab("dashboard")}
          />
      }
      <div style={S.nav}>
        <button style={S.navBtn(tab === "dashboard")} onClick={() => setTab("dashboard")}>
          <span style={S.navIcon}>📊</span>
          <span style={S.navLabel(tab === "dashboard")}>Tableau de bord</span>
        </button>
        <button style={S.navBtn(tab === "new")} onClick={() => setTab("new")}>
          <span style={S.navIcon}>✏️</span>
          <span style={S.navLabel(tab === "new")}>Nouvelle note</span>
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TABLEAU DE BORD
// ══════════════════════════════════════════════════════════════════════════════

function Dashboard({ notes, onSave, onNew }) {
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [viewNote,   setViewNote]   = useState(null);

  const years = [...new Set(notes.map(n => new Date(n.date).getFullYear()))].sort((a, b) => b - a);
  const prevYear = filterYear - 1;

  const notesYear  = notes.filter(n => new Date(n.date).getFullYear() === filterYear);
  const notesPrev  = notes.filter(n => new Date(n.date).getFullYear() === prevYear);
  const totalYear  = notesYear.reduce((s, n) => s + (n.grandTotal || 0), 0);
  const totalPrev  = notesPrev.reduce((s, n) => s + (n.grandTotal || 0), 0);
  const rembourse  = notesYear.filter(n => n.rembourse).reduce((s, n) => s + (n.grandTotal || 0), 0);
  const enAttente  = totalYear - rembourse;
  const delta      = totalPrev > 0 ? ((totalYear - totalPrev) / totalPrev * 100).toFixed(0) : null;

  const byMonth = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const cur  = notesYear.filter(n => new Date(n.date).getMonth() + 1 === m).reduce((s, n) => s + (n.grandTotal || 0), 0);
    const prev = notesPrev.filter(n => new Date(n.date).getMonth() + 1 === m).reduce((s, n) => s + (n.grandTotal || 0), 0);
    return { mois: ["Jan","Fév","Mar","Avr","Mai","Jun","Jul","Aoû","Sep","Oct","Nov","Déc"][i], cur, prev };
  });
  const maxBar = Math.max(...byMonth.map(m => Math.max(m.cur, m.prev)), 1);

  const toggleRembourse = (id) => onSave(notes.map(n => n.id === id ? { ...n, rembourse: !n.rembourse } : n));
  const deleteNote      = (id) => { if (confirm("Supprimer cette note ?")) onSave(notes.filter(n => n.id !== id)); };

  if (viewNote) return (
    <NoteDetail note={viewNote} onBack={() => setViewNote(null)} />
  );

  return (
    <div>
      <div style={S.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={S.headerTitle}>📊 Tableau de bord</div>
            <div style={S.headerSub}>{DEFAULT_NOM}</div>
          </div>
          <select value={filterYear} onChange={e => setFilterYear(parseInt(e.target.value))}
            style={{ background: "rgba(255,255,255,0.15)", color: "#fff", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 14, fontWeight: 700 }}>
            {[...new Set([filterYear, ...years])].map(y => (
              <option key={y} value={y} style={{ color: C.navy }}>{y}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={S.body}>
        {notes.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📂</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: C.navy, marginBottom: 8 }}>Aucune note de frais</div>
            <div style={{ fontSize: 14, marginBottom: 24 }}>Créez votre première note pour commencer</div>
            <button style={{ ...S.btn(), width: "auto", padding: "12px 28px" }} onClick={onNew}>+ Nouvelle note</button>
          </div>
        ) : (
          <>
            {/* Statistiques */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div style={S.statCard(C.blue)}>
                <div style={S.statVal}>{fmtShort(totalYear)}</div>
                <div style={S.statLabel}>Total {filterYear}</div>
                {delta !== null && (
                  <div style={{ fontSize: 11, marginTop: 4, color: parseFloat(delta) >= 0 ? C.danger : C.accent, fontWeight: 700 }}>
                    {parseFloat(delta) >= 0 ? "▲" : "▼"} {Math.abs(delta)}% vs {prevYear}
                  </div>
                )}
              </div>
              <div style={S.statCard(C.accent)}>
                <div style={S.statVal}>{fmtShort(rembourse)}</div>
                <div style={S.statLabel}>Remboursé</div>
                <div style={{ fontSize: 11, marginTop: 4, color: C.orange, fontWeight: 700 }}>
                  {fmtShort(enAttente)} en attente
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              <div style={S.statCard(C.orange)}>
                <div style={S.statVal}>{notesYear.length}</div>
                <div style={S.statLabel}>Notes {filterYear}</div>
              </div>
              <div style={S.statCard("#8B5CF6")}>
                <div style={S.statVal}>{fmtShort(totalPrev || 0)}</div>
                <div style={S.statLabel}>Total {prevYear}</div>
              </div>
            </div>

            {/* Graphe mensuel */}
            <div style={S.card}>
              <div style={S.secTitle}>📈 Évolution mensuelle</div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: C.blue, fontWeight: 600 }}>■ {filterYear}</span>
                <span style={{ fontSize: 11, color: "#C4B5FD", fontWeight: 600 }}>■ {prevYear}</span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80 }}>
                {byMonth.map((m, i) => (
                  <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div style={{ width: "100%", display: "flex", gap: 1, alignItems: "flex-end", height: 64 }}>
                      <div style={{ flex: 1, background: "#C4B5FD", borderRadius: "2px 2px 0 0", height: `${(m.prev / maxBar) * 100}%`, minHeight: m.prev > 0 ? 2 : 0 }} />
                      <div style={{ flex: 1, background: C.blue,    borderRadius: "2px 2px 0 0", height: `${(m.cur  / maxBar) * 100}%`, minHeight: m.cur  > 0 ? 2 : 0 }} />
                    </div>
                    <div style={{ fontSize: 9, color: C.muted, fontWeight: 600 }}>{m.mois}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Historique */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={S.secTitle}>🗂 Historique {filterYear}</div>
                <span style={{ fontSize: 12, color: C.muted }}>{notesYear.length} note(s)</span>
              </div>
              {notesYear.length === 0 && (
                <div style={{ fontSize: 14, color: C.muted, textAlign: "center", padding: "20px 0" }}>
                  Aucune note pour {filterYear}
                </div>
              )}
              {notesYear.map(note => (
                <div key={note.id} style={S.histItem(note.rembourse)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1, cursor: "pointer" }} onClick={() => setViewNote(note)}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>{note.date} — {note.motif || "Sans motif"}</div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{note.depart} → {note.destination}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, marginTop: 4 }}>{fmt(note.grandTotal)}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                      <button
                        style={{ padding: "5px 10px", borderRadius: 8, border: "none", background: note.rembourse ? C.accentLight : C.orangeLight, color: note.rembourse ? "#1a7a65" : "#9B6F00", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                        onClick={() => toggleRembourse(note.id)}>
                        {note.rembourse ? "✅ Remboursé" : "⏳ En attente"}
                      </button>
                      <button
                        style={{ padding: "5px 10px", borderRadius: 8, border: "none", background: "#FEE2E2", color: C.danger, fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                        onClick={() => deleteNote(note.id)}>🗑</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DÉTAIL NOTE — depuis l'historique
// ══════════════════════════════════════════════════════════════════════════════

function NoteDetail({ note, onBack }) {
  const rows = [
    { label: "🚗 Indemnités kilométriques", sub: `${note.km} km · ${note.cv} CV${note.electrique ? " ⚡ +20%" : ""}`, amt: fmt(note.ikMontant) },
    note.peage   > 0 && { label: "🛣 Péages",        sub: "", amt: fmt(note.peage) },
    note.parking > 0 && { label: "🅿 Stationnement", sub: "", amt: fmt(note.parking) },
    ...note.repas.map(r   => ({ label: "🍽 Restaurant",    sub: r.libelle,  amt: fmt(r.montant) })),
    ...note.cadeaux.map(c => ({ label: "🎁 Cadeau client", sub: c.libelle, amt: fmt(c.montant) })),
  ].filter(Boolean);

  return (
    <div>
      <div style={S.header}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#fff", fontSize: 16, cursor: "pointer", marginBottom: 8, padding: 0 }}>← Retour</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={S.headerTitle}>{note.motif || "Note de frais"}</div>
            <div style={S.headerSub}>{note.date} · {note.depart} → {note.destination}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, opacity: 0.6 }}>TOTAL</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#00C9A7" }}>{fmt(note.grandTotal)}</div>
          </div>
        </div>
      </div>
      <div style={S.body}>
        <div style={S.card}>
          <div style={S.secTitle}>📋 Récapitulatif</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{note.nom} · {note.date}</div>
          {rows.map((r, i) => (
            <div key={i} style={S.sumRow}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{r.label}</div>
                {r.sub && <div style={{ fontSize: 11, color: C.muted }}>{r.sub}</div>}
              </div>
              <div style={{ fontWeight: 700, color: C.blue, fontSize: 15 }}>{r.amt}</div>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0 0" }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>TOTAL À REMBOURSER</span>
            <span style={{ fontSize: 22, fontWeight: 900, color: C.accent }}>{fmt(note.grandTotal)}</span>
          </div>
        </div>
        {note.photos?.length > 0 && (
          <div style={S.card}>
            <div style={S.secTitle}>📷 Justificatifs ({note.photos.length})</div>
            <div style={S.photoGrid}>
              {note.photos.map((p, i) => <img key={i} src={p} alt="" style={S.photoThumb} />)}
            </div>
          </div>
        )}
        <div style={{ background: C.accentLight, borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 11, color: "#1a7a65" }}>
          ✅ Barème officiel URSSAF/DGFiP 2026
        </div>
        <PDFButton note={note} />
        <button style={{ ...S.btn("outline"), marginTop: 10 }} onClick={onBack}>← Retour à l'historique</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// NOUVELLE NOTE — 4 étapes
// ══════════════════════════════════════════════════════════════════════════════

function NewNote({ onSaved, onCancel }) {
  const [step, setStep] = useState(0);

  // Étape 0
  const [date,        setDate]        = useState(new Date().toISOString().split("T")[0]);
  const [nom,         setNom]         = useState(DEFAULT_NOM);
  const [motif,       setMotif]       = useState("");
  const [depart,      setDepart]      = useState("");
  const [destination, setDestination] = useState("");
  const [cv,          setCv]          = useState("5");
  const [km,          setKm]          = useState("");
  const [electrique,  setElectrique]  = useState(false);
  const [kmCumules,   setKmCumules]   = useState("");
  const [loadingDist, setLoadingDist] = useState(false);
  const [distError,   setDistError]   = useState("");

  // Étape 1
  const [peage,     setPeage]     = useState("");
  const [parking,   setParking]   = useState("");
  const [repas,     setRepas]     = useState([]);
  const [repasIn,   setRepasIn]   = useState({ libelle: "", montant: "" });
  const [cadeaux,   setCadeaux]   = useState([]);
  const [cadeauIn,  setCadeauIn]  = useState({ libelle: "", montant: "" });
  const [photos,    setPhotos]    = useState([]);
  const fileRef = useRef();

  // Étape 3
  const [savedNote, setSavedNote] = useState(null);

  // Calculs
  const ikMontant   = km && cv ? calcIK(cv, km, electrique, kmCumules) : 0;
  const totalRepas  = repas.reduce((s, r) => s + parseFloat(r.montant || 0), 0);
  const totalCadx   = cadeaux.reduce((s, c) => s + parseFloat(c.montant || 0), 0);
  const totalPeage  = parseFloat(peage  || 0);
  const totalPark   = parseFloat(parking || 0);
  const grandTotal  = ikMontant + totalPeage + totalPark + totalRepas + totalCadx;

  const getIkInfo = () => {
    if (!km || !cv) return "";
    const total = (parseFloat(kmCumules) || 0) + parseFloat(km);
    const t = total <= 5000 ? "≤ 5 000 km" : total <= 20000 ? "5 001–20 000 km" : "> 20 000 km";
    return `Tranche ${t} · ${cv} CV${electrique ? " ⚡ +20%" : ""}`;
  };

  const fetchDistance = async () => {
    if (!depart.trim() || !destination.trim()) return;
    setLoadingDist(true); setDistError("");
    try {
      const d = await getDistance(depart, destination);
      setKm(String(d));
    } catch (e) {
      setDistError(e.message);
    }
    setLoadingDist(false);
  };

  const handlePhoto = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const total = photos.length + files.length;
    const compressed = await Promise.all(files.map(f => compressImage(f, 950, total)));
    setPhotos(prev => [...prev, ...compressed]);
    e.target.value = "";
  };

  const buildNote = () => ({
    id: Date.now(),
    date, nom, motif, depart, destination,
    cv, km: parseFloat(km), electrique,
    kmCumules: parseFloat(kmCumules || 0),
    peage: totalPeage, parking: totalPark,
    repas, cadeaux, photos,
    ikMontant, grandTotal,
    rembourse: false,
  });

  const handleGenerate = () => {
    const note = buildNote();
    onSaved(note);
    setSavedNote(note);
    setStep(3);
  };

  return (
    <div>
      <div style={S.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <button onClick={onCancel} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", fontSize: 13, cursor: "pointer", padding: 0, marginBottom: 6 }}>✕ Annuler</button>
            <div style={S.headerTitle}>✏️ {STEPS[step]}</div>
            <div style={S.headerSub}>Étape {step + 1} / {STEPS.length}</div>
          </div>
          {grandTotal > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, opacity: 0.6 }}>Total</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(grandTotal)}</div>
            </div>
          )}
        </div>
        <div style={S.stepBar}>{STEPS.map((_, i) => <div key={i} style={S.stepDot(i === step, i < step)} />)}</div>
      </div>

      <div style={S.body}>

        {/* ── STEP 0 : TRAJET ── */}
        {step === 0 && <>
          <div style={S.card}>
            <div style={S.secTitle}>🗓 Informations</div>
            <label style={S.label}>Votre nom</label>
            <input style={{ ...S.input, marginBottom: 12 }} value={nom} onChange={e => setNom(e.target.value)} />
            <label style={S.label}>Date</label>
            <input style={{ ...S.input, marginBottom: 12 }} type="date" value={date} onChange={e => setDate(e.target.value)} />
            <label style={S.label}>Motif du déplacement</label>
            <input style={S.input} value={motif} onChange={e => setMotif(e.target.value)} placeholder="Visite client – Société XYZ" />
          </div>

          <div style={S.card}>
            <div style={S.secTitle}>📍 Trajet</div>
            <label style={S.label}>Départ</label>
            <input style={{ ...S.input, marginBottom: 10 }} value={depart}
              onChange={e => { setDepart(e.target.value); setKm(""); setDistError(""); }}
              placeholder="Adresse, ville, code postal…" />
            <label style={S.label}>Destination</label>
            <input style={{ ...S.input, marginBottom: 10 }} value={destination}
              onChange={e => { setDestination(e.target.value); setKm(""); setDistError(""); }}
              placeholder="Adresse, ville, code postal…" />
            <button style={{ ...S.btn(loadingDist ? "outline" : "primary"), marginBottom: 10 }}
              onClick={fetchDistance} disabled={loadingDist || !depart || !destination}>
              {loadingDist ? "⏳ Calcul en cours…" : "🗺 Calculer la distance aller-retour"}
            </button>
            {distError && (
              <div style={{ color: C.danger, fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>{distError}</div>
            )}
            <label style={S.label}>Distance aller-retour (km)</label>
            <input style={S.input} type="number" value={km} onChange={e => setKm(e.target.value)}
              placeholder="Calculée automatiquement ou saisir manuellement" />
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
              ⚡ Via OpenRouteService — fonctionne avec villes, codes postaux, adresses complètes
            </div>
          </div>

          <div style={S.card}>
            <div style={S.secTitle}>🚗 Véhicule</div>
            <label style={S.label}>Puissance fiscale (case P.6 carte grise)</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {["3","4","5","6","7"].map(v => (
                <button key={v} style={S.chip(cv === v)} onClick={() => setCv(v)}>
                  {v === "3" ? "≤3 CV" : v === "7" ? "≥7 CV" : `${v} CV`}
                </button>
              ))}
            </div>
            <label style={S.label}>Motorisation</label>
            <div style={{ ...S.row, marginBottom: 14 }}>
              <button style={S.toggle(!electrique)} onClick={() => setElectrique(false)}>⛽ Thermique</button>
              <button style={S.toggle(electrique)}  onClick={() => setElectrique(true)}>⚡ Électrique +20%</button>
            </div>
            <label style={S.label}>Km professionnels cumulés cette année (optionnel)</label>
            <input style={S.input} type="number" value={kmCumules} onChange={e => setKmCumules(e.target.value)}
              placeholder="Pour déterminer la bonne tranche" />
            {km && cv && (
              <div style={S.ikBadge}>
                <div style={{ fontSize: 12, marginBottom: 3 }}>{getIkInfo()}</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>IK = {fmt(ikMontant)}</div>
              </div>
            )}
          </div>

          <button style={S.btn()} onClick={() => setStep(1)} disabled={!km || !cv || !nom}>
            Continuer → Frais annexes
          </button>
        </>}

        {/* ── STEP 1 : FRAIS ── */}
        {step === 1 && <>
          <div style={S.card}>
            <div style={S.secTitle}>🛣 Péage & Stationnement</div>
            <label style={S.label}>Péages (€)</label>
            <input style={{ ...S.input, marginBottom: 12 }} type="number" value={peage}
              onChange={e => setPeage(e.target.value)} placeholder="0.00" />
            <label style={S.label}>Stationnement (€)</label>
            <input style={S.input} type="number" value={parking}
              onChange={e => setParking(e.target.value)} placeholder="0.00" />
          </div>

          <div style={S.card}>
            <div style={S.secTitle}>🍽 Restaurant / Frais de bouche</div>
            {repas.map((r, i) => (
              <div key={r.id} style={S.sumRow}>
                <span style={{ fontSize: 14 }}>{r.libelle}</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontWeight: 700 }}>{fmt(r.montant)}</span>
                  <button style={{ background: "none", border: "none", color: C.danger, cursor: "pointer", fontSize: 16 }}
                    onClick={() => setRepas(repas.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            ))}
            <div style={{ ...S.row, marginTop: 10 }}>
              <input style={{ ...S.input, flex: 2 }} value={repasIn.libelle}
                onChange={e => setRepasIn({ ...repasIn, libelle: e.target.value })} placeholder="Libellé" />
              <input style={{ ...S.input, flex: 1 }} type="number" value={repasIn.montant}
                onChange={e => setRepasIn({ ...repasIn, montant: e.target.value })} placeholder="€" />
            </div>
            <button style={{ ...S.btn("outline"), marginTop: 8 }} onClick={() => {
              if (repasIn.libelle && repasIn.montant) {
                setRepas([...repas, { ...repasIn, id: Date.now() }]);
                setRepasIn({ libelle: "", montant: "" });
              }
            }}>+ Ajouter un repas</button>
          </div>

          <div style={S.card}>
            <div style={S.secTitle}>🎁 Cadeaux clients</div>
            {cadeaux.map((c, i) => (
              <div key={c.id} style={S.sumRow}>
                <span style={{ fontSize: 14 }}>{c.libelle}</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontWeight: 700 }}>{fmt(c.montant)}</span>
                  <button style={{ background: "none", border: "none", color: C.danger, cursor: "pointer", fontSize: 16 }}
                    onClick={() => setCadeaux(cadeaux.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            ))}
            <div style={{ ...S.row, marginTop: 10 }}>
              <input style={{ ...S.input, flex: 2 }} value={cadeauIn.libelle}
                onChange={e => setCadeauIn({ ...cadeauIn, libelle: e.target.value })} placeholder="Libellé" />
              <input style={{ ...S.input, flex: 1 }} type="number" value={cadeauIn.montant}
                onChange={e => setCadeauIn({ ...cadeauIn, montant: e.target.value })} placeholder="€" />
            </div>
            <button style={{ ...S.btn("outline"), marginTop: 8 }} onClick={() => {
              if (cadeauIn.libelle && cadeauIn.montant) {
                setCadeaux([...cadeaux, { ...cadeauIn, id: Date.now() }]);
                setCadeauIn({ libelle: "", montant: "" });
              }
            }}>+ Ajouter un cadeau</button>
          </div>

          <div style={S.card}>
            <div style={S.secTitle}>📷 Photos des justificatifs</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
              Prenez en photo tickets et reçus. Compression automatique ≤ 1 Mo.
            </div>
            <div style={S.photoGrid}>
              {photos.map((p, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <img src={p} alt="" style={S.photoThumb} />
                  <button style={{ position: "absolute", top: -6, right: -6, background: C.danger, color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontSize: 11, fontWeight: 700 }}
                    onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <div style={S.addPhoto} onClick={() => fileRef.current.click()}>
                <span style={{ fontSize: 22 }}>📷</span><span>Ajouter</span>
              </div>
              <input ref={fileRef} type="file" accept="image/*" multiple capture="environment"
                style={{ display: "none" }} onChange={handlePhoto} />
            </div>
            {photos.length > 0 && (
              <div style={{ fontSize: 12, color: C.accent, fontWeight: 700, marginTop: 8 }}>
                ✅ {photos.length} justificatif(s)
              </div>
            )}
          </div>

          <div style={S.row}>
            <button style={{ ...S.btn("outline"), flex: 1 }} onClick={() => setStep(0)}>← Retour</button>
            <button style={{ ...S.btn(), flex: 2 }} onClick={() => setStep(2)}>Récapitulatif →</button>
          </div>
        </>}

        {/* ── STEP 2 : RÉCAP ── */}
        {step === 2 && <>
          <div style={S.card}>
            <div style={S.secTitle}>📋 Récapitulatif</div>
            <div style={{ fontSize: 13, color: C.muted }}>{date} · {motif || "—"}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.navy, marginBottom: 14 }}>{depart} → {destination}</div>

            <div style={S.sumRow}>
              <div>
                <div style={{ fontSize: 14 }}>🚗 Indemnités kilométriques</div>
                <div style={{ fontSize: 11, color: C.muted }}>{km} km · {getIkInfo()}</div>
              </div>
              <div style={{ fontWeight: 700, color: C.blue }}>{fmt(ikMontant)}</div>
            </div>
            {totalPeage > 0 && (
              <div style={S.sumRow}>
                <span>🛣 Péages</span>
                <span style={{ fontWeight: 700, color: C.blue }}>{fmt(totalPeage)}</span>
              </div>
            )}
            {totalPark > 0 && (
              <div style={S.sumRow}>
                <span>🅿 Stationnement</span>
                <span style={{ fontWeight: 700, color: C.blue }}>{fmt(totalPark)}</span>
              </div>
            )}
            {repas.map(r => (
              <div key={r.id} style={S.sumRow}>
                <div><div>🍽 Restaurant</div><div style={{ fontSize: 11, color: C.muted }}>{r.libelle}</div></div>
                <span style={{ fontWeight: 700, color: C.blue }}>{fmt(r.montant)}</span>
              </div>
            ))}
            {cadeaux.map(c => (
              <div key={c.id} style={S.sumRow}>
                <div><div>🎁 Cadeau client</div><div style={{ fontSize: 11, color: C.muted }}>{c.libelle}</div></div>
                <span style={{ fontWeight: 700, color: C.blue }}>{fmt(c.montant)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 0 0", fontWeight: 800 }}>
              <span style={{ fontSize: 16, color: C.navy }}>TOTAL</span>
              <span style={{ fontSize: 22, color: C.accent }}>{fmt(grandTotal)}</span>
            </div>
          </div>

          {photos.length > 0 && (
            <div style={S.card}>
              <div style={S.secTitle}>📷 Justificatifs ({photos.length})</div>
              <div style={S.photoGrid}>
                {photos.map((p, i) => <img key={i} src={p} alt="" style={S.photoThumb} />)}
              </div>
            </div>
          )}

          <div style={{ background: C.accentLight, borderRadius: 12, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#1a7a65" }}>
            ✅ Barème officiel URSSAF/DGFiP 2026
          </div>

          <div style={S.row}>
            <button style={{ ...S.btn("outline"), flex: 1 }} onClick={() => setStep(1)}>← Retour</button>
            <button style={{ ...S.btn(), flex: 2 }} onClick={handleGenerate}>Générer & Partager →</button>
          </div>
        </>}

        {/* ── STEP 3 : PDF ── */}
        {step === 3 && (
          <div style={S.card}>
            <div style={S.secTitle}>📄 PDF & Partage</div>
            {savedNote ? (
              <>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
                  Note enregistrée ✅ · Total : <strong style={{ color: C.accent }}>{fmt(savedNote.grandTotal)}</strong>
                  {savedNote.photos?.length > 0 && <> · {savedNote.photos.length} justificatif(s)</>}
                </div>
                <PDFButton note={savedNote} />
              </>
            ) : (
              <div style={{ color: C.muted, fontSize: 13 }}>
                Revenez à l'étape précédente.
              </div>
            )}
            <div style={{ background: C.accentLight, borderRadius: 10, padding: "10px 14px", margin: "14px 0", fontSize: 12, color: "#1a7a65" }}>
              ✅ Barème URSSAF/DGFiP 2026 · Sauvegardé dans l'historique
            </div>
            <button style={S.btn("outline")} onClick={onCancel}>← Tableau de bord</button>
          </div>
        )}

      </div>
    </div>
  );
}
