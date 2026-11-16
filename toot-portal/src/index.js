// Toot Trays order portal for Prince Fabrication.
// Orders are written straight into the production dashboard's D1 database.
// Nothing in this app ever deletes a record; D1 triggers block deletes on the portal tables too.

import PAGE from "./page.html";

const PRODUCTS = [
  { key: "tray_16x12", name: "Tray 16 × 12", w: 16, h: 12, price: 15 },
  { key: "tray_12x12", name: "Tray 12 × 12", w: 12, h: 12, price: 11.25 },
  { key: "catchall", name: "Catchall tray (small)", w: null, h: null, price: 5 },
  { key: "coasters", name: "Coaster set, 4 pack (4 × 4)", w: 4, h: 4, price: 10 },
];
const CLIENT = { name: "Nicola", company: "Toot Trays", email: "toottrays@gmail.com" };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const now = () => new Date().toISOString();
const enc = new TextEncoder();

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode((env.PORTAL_PASSWORD || "") + "|" + (env.OWNER_PASSWORD || "") + "|toot"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function getRole(req, env) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)tt=([^;]+)/);
  if (!m) return null;
  const [role, sig] = decodeURIComponent(m[1]).split(".");
  if (role !== "shared" && role !== "owner") return null;
  return safeEqual(sig, await hmac(env, "session:" + role)) ? role : null;
}

const who = (role) => (role === "owner" ? "Anthony" : "Toot Trays");

async function fileUrl(env, origin, id) {
  return `${origin}/f/${id}/${await hmac(env, "file:" + id)}`;
}

async function log(env, orderId, role, action, detail) {
  await env.DB.prepare("INSERT INTO portal_log (order_id, at, who, action, detail) VALUES (?,?,?,?,?)")
    .bind(orderId, now(), who(role), action, detail || null)
    .run();
}

async function saveFile(env, orderId, itemId, kind, file, role) {
  const key = `${orderId}/${kind}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${(file.name || "file").replace(/[^\w.]+/g, "_")}`;
  await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  const r = await env.DB.prepare(
    "INSERT INTO portal_files (order_id, item_id, kind, r2_key, name, mime, size, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id"
  )
    .bind(orderId, itemId, kind, key, file.name || "file", file.type || "", file.size || 0, who(role), now())
    .first();
  return r.id;
}

// Rebuild the dashboard copy of this order from the portal record.
async function syncDashboard(env, origin, orderId) {
  const o = await env.DB.prepare("SELECT * FROM portal_orders WHERE id=?").bind(orderId).first();
  if (!o) return;
  const items = (await env.DB.prepare("SELECT * FROM portal_items WHERE order_id=? ORDER BY id").bind(orderId).all()).results;
  const files = (await env.DB.prepare("SELECT * FROM portal_files WHERE order_id=? ORDER BY id").bind(orderId).all()).results;
  const labels = files.filter((f) => f.kind === "label");
  const dashId = o.dash_order_id || "toot:" + orderId;
  const labelLines = [];
  for (const l of labels) labelLines.push(`Her prepaid label: ${await fileUrl(env, origin, l.id)}`);
  const shopNote = [
    `Toot Trays portal order TT ${orderId}. Labor only: she supplies the blank trays (from Amazon).`,
    "Reuse her tray box and slide it into her poly mailer for the return.",
    labels.length ? labelLines.join("\n") : "Shipping label: not uploaded yet.",
  ].join("\n");

  const existing = await env.DB.prepare("SELECT id FROM orders WHERE id=?").bind(dashId).first();
  const ts = now();
  const stmts = [];
  if (!existing) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO orders (id, channel, channel_order_no, customer, email, company, order_date, ship_by, make_by, status, priority, total, buyer_note, notes, is_quote, source, created_at, updated_at, process, ship_by_set)
         VALUES (?,?,?,?,?,?,?,?,?,'new',3,?,?,?,0,'manual',?,?,'uv',?)`
      ).bind(
        dashId, "Email", "TT " + orderId, CLIENT.name, CLIENT.email, CLIENT.company, ts.slice(0, 10),
        o.due_date || null, o.due_date || null, o.total, o.notes || "", shopNote, ts, ts, o.due_date ? 1 : 0
      )
    );
  } else {
    stmts.push(
      env.DB.prepare("UPDATE orders SET ship_by=?, make_by=?, total=?, buyer_note=?, notes=?, updated_at=? WHERE id=?")
        .bind(o.due_date || null, o.due_date || null, o.total, o.notes || "", shopNote, ts, dashId)
    );
  }
  // Items: tagged with ext_id so they can be refreshed without touching anything else.
  for (const it of items) {
    const art = files.filter((f) => f.kind === "artwork" && f.item_id === it.id).pop();
    const artUrl = art ? await fileUrl(env, origin, art.id) : null;
    const isImg = art && /^image\/(png|jpe?g|webp|gif)$/i.test(art.mime || "");
    const name = `${it.qty === 0 ? "REMOVED: " : ""}${it.design ? it.design + ", " : ""}${it.product} (UV print, her blank)`;
    const ext = "portal:" + it.id;
    const ex = await env.DB.prepare("SELECT id FROM order_items WHERE ext_id=? AND order_id=?").bind(ext, dashId).first();
    if (ex) {
      stmts.push(
        env.DB.prepare("UPDATE order_items SET product_name=?, qty=?, unit_price=?, w_in=?, h_in=?, print_file=?, image_url=? WHERE id=?")
          .bind(name, it.qty, it.unit_price, it.w_in, it.h_in, artUrl, isImg ? artUrl : null, ex.id)
      );
    } else {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO order_items (order_id, product_name, personalization, qty, w_in, h_in, unit_price, process, print_file, image_url, ext_id) VALUES (?,?,?,?,?,?,?,'uv',?,?,?)"
        ).bind(dashId, name, it.design || "", it.qty, it.w_in, it.h_in, it.unit_price, artUrl, isImg ? artUrl : null, ext)
      );
    }
  }
  if (!o.dash_order_id) stmts.push(env.DB.prepare("UPDATE portal_orders SET dash_order_id=? WHERE id=?").bind(dashId, orderId));
  await env.DB.batch(stmts);
}

function deriveStatus(o) {
  if (o.dash_status === "canceled") return "canceled";
  if (o.dash_status === "shipped" || o.dash_status === "done" || o.stage === "complete") return "complete";
  if (o.stage === "in_production") return "in_production";
  return "received";
}

async function loadOrders(env, origin, id) {
  const where = id ? "WHERE p.id=?" : "";
  const q = env.DB.prepare(
    `SELECT p.*, d.status AS dash_status FROM portal_orders p LEFT JOIN orders d ON d.id=p.dash_order_id ${where} ORDER BY p.id DESC`
  );
  const orders = (id ? await q.bind(id).all() : await q.all()).results;
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const ph = ids.map(() => "?").join(",");
  const items = (await env.DB.prepare(`SELECT * FROM portal_items WHERE order_id IN (${ph}) ORDER BY id`).bind(...ids).all()).results;
  const files = (await env.DB.prepare(`SELECT * FROM portal_files WHERE order_id IN (${ph}) ORDER BY id`).bind(...ids).all()).results;
  for (const f of files) f.url = await fileUrl(env, origin, f.id);
  return orders.map((o) => ({
    id: o.id,
    due_date: o.due_date,
    notes: o.notes,
    total: o.total,
    created_at: o.created_at,
    status: deriveStatus(o),
    items: items
      .filter((i) => i.order_id === o.id)
      .map((i) => ({ ...i, artwork: files.filter((f) => f.kind === "artwork" && f.item_id === i.id) })),
    labels: files.filter((f) => f.order_id === o.id && f.kind === "label"),
  }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const origin = url.origin;

    // Signed file links (so the dashboard can open artwork and labels without logging in)
    const fm = p.match(/^\/f\/(\d+)\/([\w-]+)$/);
    if (fm) {
      if (!safeEqual(fm[2], await hmac(env, "file:" + fm[1]))) return new Response("Not found", { status: 404 });
      const f = await env.DB.prepare("SELECT * FROM portal_files WHERE id=?").bind(fm[1]).first();
      const obj = f && (await env.FILES.get(f.r2_key));
      if (!obj) return new Response("Not found", { status: 404 });
      const dl = url.searchParams.has("download") ? "attachment" : "inline";
      return new Response(obj.body, {
        headers: {
          "content-type": f.mime || "application/octet-stream",
          "content-disposition": `${dl}; filename="${(f.name || "file").replace(/"/g, "")}"`,
          "cache-control": "private, max-age=3600",
        },
      });
    }

    if (p === "/" || p === "/index.html") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (p === "/api/login" && req.method === "POST") {
      const { password } = await req.json().catch(() => ({}));
      let role = null;
      if (env.OWNER_PASSWORD && safeEqual(password || "", env.OWNER_PASSWORD)) role = "owner";
      else if (env.PORTAL_PASSWORD && safeEqual(password || "", env.PORTAL_PASSWORD)) role = "shared";
      if (!role) return json({ error: "That password didn’t work." }, 401);
      const val = encodeURIComponent(role + "." + (await hmac(env, "session:" + role)));
      return new Response(JSON.stringify({ role }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `tt=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        },
      });
    }
    if (p === "/api/logout" && req.method === "POST") {
      return new Response("{}", { headers: { "set-cookie": "tt=; Path=/; Max-Age=0" } });
    }

    const role = await getRole(req, env);
    if (p.startsWith("/api/") && !role) return json({ error: "Please sign in." }, 401);

    if (p === "/api/me") return json({ role, products: PRODUCTS });

    if (p === "/api/orders" && req.method === "GET") return json(await loadOrders(env, origin));

    if (p === "/api/orders" && req.method === "POST") {
      const form = await req.formData();
      const data = JSON.parse(form.get("data") || "{}");
      const lines = (data.items || []).filter((i) => i && PRODUCTS.find((x) => x.key === i.product) && Number(i.qty) > 0);
      if (!lines.length) return json({ error: "Add at least one tray." }, 400);
      const priced = lines.map((l) => {
        const pr = PRODUCTS.find((x) => x.key === l.product);
        return { pr, design: String(l.design || "").slice(0, 200), qty: Math.min(9999, Math.round(Number(l.qty))) };
      });
      const total = Math.round(priced.reduce((s, l) => s + l.pr.price * l.qty, 0) * 100) / 100;
      const ts = now();
      const o = await env.DB.prepare(
        "INSERT INTO portal_orders (client, due_date, notes, total, stage, created_at, created_by, updated_at) VALUES ('toot',?,?,?,'submitted',?,?,?) RETURNING id"
      )
        .bind(data.due_date || null, String(data.notes || "").slice(0, 4000), total, ts, who(role), ts)
        .first();
      const orderId = o.id;
      const itemIds = [];
      for (const l of priced) {
        const r = await env.DB.prepare(
          "INSERT INTO portal_items (order_id, product, design, qty, unit_price, w_in, h_in) VALUES (?,?,?,?,?,?,?) RETURNING id"
        )
          .bind(orderId, l.pr.name, l.design, l.qty, l.pr.price, l.pr.w, l.pr.h)
          .first();
        itemIds.push(r.id);
      }
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") continue;
        const am = k.match(/^art_(\d+)$/);
        if (am && itemIds[+am[1]] != null) await saveFile(env, orderId, itemIds[+am[1]], "artwork", v, role);
        if (k === "label") await saveFile(env, orderId, null, "label", v, role);
      }
      await log(env, orderId, role, "Order placed", priced.map((l) => `${l.qty} × ${l.pr.name}${l.design ? " (" + l.design + ")" : ""}`).join(", "));
      await syncDashboard(env, origin, orderId);
      return json((await loadOrders(env, origin, orderId))[0]);
    }

    const om = p.match(/^\/api\/orders\/(\d+)(?:\/(\w+))?$/);
    if (om) {
      const id = +om[1];
      const action = om[2];
      const exists = await env.DB.prepare("SELECT * FROM portal_orders WHERE id=?").bind(id).first();
      if (!exists) return json({ error: "Order not found." }, 404);

      if (!action && req.method === "GET") {
        const [order] = await loadOrders(env, origin, id);
        order.history = (await env.DB.prepare("SELECT * FROM portal_log WHERE order_id=? ORDER BY id").bind(id).all()).results;
        return json(order);
      }

      if (action === "files" && req.method === "POST") {
        const form = await req.formData();
        const kind = form.get("kind") === "label" ? "label" : "artwork";
        const itemId = form.get("item_id") ? +form.get("item_id") : null;
        if (kind === "artwork") {
          const it = await env.DB.prepare("SELECT id FROM portal_items WHERE id=? AND order_id=?").bind(itemId, id).first();
          if (!it) return json({ error: "Pick a tray for this artwork." }, 400);
        }
        const names = [];
        for (const v of form.getAll("file")) {
          if (typeof v === "string") continue;
          await saveFile(env, id, itemId, kind, v, role);
          names.push(v.name);
        }
        if (!names.length) return json({ error: "No file attached." }, 400);
        await log(env, id, role, kind === "label" ? "Shipping label added" : "Artwork added", names.join(", "));
        await env.DB.prepare("UPDATE portal_orders SET updated_at=? WHERE id=?").bind(now(), id).run();
        await syncDashboard(env, origin, id);
        return json({ ok: true });
      }

      if (action === "edit" && req.method === "POST") {
        const b = await req.json();
        const changes = [];
        if ("due_date" in b && (b.due_date || null) !== exists.due_date) changes.push(`Due date ${exists.due_date || "none"} → ${b.due_date || "none"}`);
        if ("notes" in b && (b.notes || "") !== (exists.notes || "")) changes.push("Notes updated");
        if (!changes.length) return json({ ok: true });
        await env.DB.prepare("UPDATE portal_orders SET due_date=?, notes=?, updated_at=? WHERE id=?")
          .bind("due_date" in b ? b.due_date || null : exists.due_date, "notes" in b ? String(b.notes || "").slice(0, 4000) : exists.notes, now(), id)
          .run();
        await log(env, id, role, "Order edited", changes.join("; ") + (b.notes !== undefined && b.notes !== exists.notes ? `\nPrevious notes: ${exists.notes || "(none)"}` : ""));
        await syncDashboard(env, origin, id);
        return json({ ok: true });
      }

      if (action === "items" && req.method === "POST") {
        // Change size/qty/design of a tray line, or add a new line. Qty 0 marks a line removed (kept in history).
        const b = await req.json();
        const pr = PRODUCTS.find((x) => x.key === b.product);
        if (!pr) return json({ error: "Pick a size." }, 400);
        const qty = Math.max(0, Math.min(9999, Math.round(Number(b.qty))));
        if (!Number.isFinite(qty)) return json({ error: "Enter a quantity." }, 400);
        const design = String(b.design || "").slice(0, 200);
        let detail;
        if (b.item_id) {
          const it = await env.DB.prepare("SELECT * FROM portal_items WHERE id=? AND order_id=?").bind(b.item_id, id).first();
          if (!it) return json({ error: "Tray not found." }, 404);
          const ch = [];
          if (it.product !== pr.name) ch.push(`size ${it.product} → ${pr.name}`);
          if (it.qty !== qty) ch.push(`qty ${it.qty} → ${qty}${qty === 0 ? " (removed)" : ""}`);
          if ((it.design || "") !== design) ch.push(`design "${it.design || ""}" → "${design}"`);
          if (!ch.length) return json({ ok: true });
          await env.DB.prepare("UPDATE portal_items SET product=?, design=?, qty=?, unit_price=?, w_in=?, h_in=? WHERE id=?")
            .bind(pr.name, design, qty, pr.price, pr.w, pr.h, it.id).run();
          detail = `${it.design || it.product}: ${ch.join("; ")}`;
        } else {
          if (!qty) return json({ error: "Enter a quantity." }, 400);
          await env.DB.prepare("INSERT INTO portal_items (order_id, product, design, qty, unit_price, w_in, h_in) VALUES (?,?,?,?,?,?,?)")
            .bind(id, pr.name, design, qty, pr.price, pr.w, pr.h).run();
          detail = `Added ${qty} × ${pr.name}${design ? " (" + design + ")" : ""}`;
        }
        const t = await env.DB.prepare("SELECT COALESCE(SUM(qty*unit_price),0) t FROM portal_items WHERE order_id=?").bind(id).first();
        const total = Math.round(t.t * 100) / 100;
        await env.DB.prepare("UPDATE portal_orders SET total=?, updated_at=? WHERE id=?").bind(total, now(), id).run();
        await log(env, id, role, "Trays changed", detail + `\nNew total ${"$" + total.toFixed(2)}`);
        await syncDashboard(env, origin, id);
        return json({ ok: true });
      }

      if (action === "message" && req.method === "POST") {
        const { text } = await req.json();
        if (!String(text || "").trim()) return json({ error: "Message is empty." }, 400);
        await log(env, id, role, "Message", String(text).slice(0, 4000));
        return json({ ok: true });
      }

      if (action === "stage" && req.method === "POST") {
        if (role !== "owner") return json({ error: "Only the shop can change status." }, 403);
        const { stage } = await req.json();
        if (!["submitted", "in_production", "complete"].includes(stage)) return json({ error: "Bad status." }, 400);
        await env.DB.prepare("UPDATE portal_orders SET stage=?, updated_at=? WHERE id=?").bind(stage, now(), id).run();
        if (exists.dash_order_id) {
          const st = stage === "complete" ? "shipped" : "new";
          await env.DB.prepare("UPDATE orders SET status=?, updated_at=? WHERE id=? AND status IN ('new','shipped')").bind(st, now(), exists.dash_order_id).run();
        }
        await log(env, id, role, "Status", { submitted: "Received", in_production: "In production", complete: "Complete" }[stage]);
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
