
import express from "express";
import { chromium } from "playwright";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

let browser;
async function startBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    console.log("✅ Browser started");
  }
}
async function closeBrowser() {
  if (browser) {
    await browser.close().catch(()=>{});
    browser = null;
    console.log("🛑 Browser closed");
  }
}

app.get("/", (req, res) => res.send("ISP coverage API"));

app.get("/coverage", async (req, res) => {
  const addressRaw = (req.query.address || "").trim();
  const option = Math.max(1, parseInt(req.query.option || "1", 10)); // 1-based
  if (!addressRaw) return res.status(400).json({ error: "Falta parámetro address" });

  await startBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // 1) Ir a la página de planes
    await page.goto("https://www.att.com/buy/internet/plans", { waitUntil: "domcontentloaded", timeout: 60000 });

    // 2) Rellenar el input
    const inputSel = "#input-addressInput";
    await page.waitForSelector(inputSel, { timeout: 30000 });
    await page.fill(inputSel, addressRaw);

    // 3) Esperar a que haya elementos visibles dentro del contenedor de sugerencias
    const containerSel = "#aria-control-addressInput";
    await page.waitForSelector(containerSel, { timeout: 10000 });

    await page.waitForFunction((sel) => {
      const c = document.querySelector(sel);
      if (!c) return false;
      const nodes = Array.from(c.querySelectorAll("*"));
      return nodes.some(n => {
        try {
          const t = (n.innerText || "").trim();
          const r = n.getBoundingClientRect();
          return t.length > 0 && r && r.width > 1 && r.height > 1;
        } catch (e) {
          return false;
        }
      });
    }, containerSel, { timeout: 10000 });

    // 4) Recolectar elementos visibles y sus textos (en el orden que aparecen)
    const visibleItems = [];
    const candidateHandles = await page.$$( `${containerSel} *` );
    for (const h of candidateHandles) {
      const text = (await h.evaluate(n => (n.innerText || "").trim())).trim();
      const box = await h.boundingBox();
      if (text && box && box.width > 1 && box.height > 1) {
        visibleItems.push({ handle: h, text });
      }
    }

    // deduplicar por texto y mantener orden
    const seen = new Set();
    const suggestions = [];
    const handles = [];
    for (const it of visibleItems) {
      if (!seen.has(it.text)) {
        seen.add(it.text);
        suggestions.push(it.text);
        handles.push(it.handle);
      } else {
        // si duplicado, cerrar handle para evitar memory leak
        try { await it.handle.dispose(); } catch(e){}
      }
    }

    // Si no hay sugerencias, devolver el array vacío (y debug)
    if (!suggestions.length) {
      await page.close();
      await context.close();
      return res.json({
        address: addressRaw,
        suggestions: [],
        coverage: ["ℹ️ No aparecieron sugerencias en el dropdown. Intenta el formato completo: 'Calle, Ciudad, Estado ZIP'"]
      });
    }

    // 5) Seleccionar la opción pedida (1-based)
    const idx = option - 1;
    if (idx < 0 || idx >= handles.length) {
      // liberar handles
      for (const h of handles) { try { await h.dispose(); } catch(e){} }
      await page.close();
      await context.close();
      return res.status(400).json({ error: `Opción inválida. Hay ${handles.length} sugerencias. Usa option=1..${handles.length}` });
    }

    // hacer scroll y click seguro en el handle elegido
    const chosenHandle = handles[idx];
    try {
      await chosenHandle.scrollIntoViewIfNeeded();
      await chosenHandle.click({ timeout: 10000 });
    } catch (clickErr) {
      // en caso de fallo de click, intentar click via JS (dispatch Event)
      await chosenHandle.evaluate(n => { n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    }

    // liberar handles no necesarios (excepto chosen, que ya se usó)
    for (let i=0;i<handles.length;i++){
      if (i !== idx) { try { await handles[i].dispose(); } catch(e){} }
    }

    // 6) Click en botón "Check availability" (intentar varios selectores)
    const checkBtnSelectors = [
      "button[data-testid='checkAvailabilityId']",
      "#Check-availability-btn-7107",
      "button[id^='Check-availability-btn']",
      "button:has-text('Check availability')"
    ];
    let clickedCheck = false;
    for (const sel of checkBtnSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await Promise.all([
          // a veces la acción navega o modifica el DOM intensamente
          page.waitForTimeout(300), // pequeño delay para que la UI estabilice
          btn.click({ timeout: 10000 })
        ]);
        clickedCheck = true;
        break;
      }
    }
    if (!clickedCheck) {
      // no encontramos botón conocido, intentar presionar Enter en el input
      await page.focus(inputSel);
      await page.keyboard.press("Enter");
    }

    // 7) Esperar a que aparezca resultado (planes o mensaje) - timeout mayor
    await page.waitForTimeout(1500); // margen inicial
    await page.waitForFunction(() => {
      const text = document.body.innerText.toLowerCase();
      // patrones que indican página con resultado o mensaje de no disponibilidad
      if (text.includes("not available") || text.includes("no availability") || text.includes("is not available") || text.includes("no service") ) return true;
      if (text.includes("available") || text.includes("great news") || text.includes("is available") || text.includes("availability")) return true;
      // si hay plan cards u otros componentes típicos
      const plan = document.querySelector("[data-testid='planCard'], .plan-card, attwc-internet-plans, att-internet-plans");
      if (plan) return true;
      return false;
    }, { timeout: 30000 }).catch(()=>null); // no fallamos si no aparece en 30s

    // 8) Obtener HTML y parsear con cheerio
    const html = await page.content();
    const $ = cheerio.load(html);
    const bodyText = $("body").text().replace(/\s+/g, " ").toLowerCase();

    // Buscar planes
    const planEls = $("*[data-testid='planCard'], .plan-card, attwc-internet-plans, att-internet-plans");
    const plans = [];
    if (planEls.length > 0) {
      planEls.each((i, el) => {
        const text = $(el).text().replace(/\s+/g," ").trim();
        if (text) plans.push(text);
      });
    }

    // Determinar disponibilidad con patrones
    let availability = "ℹ️ No se pudo determinar la cobertura";
    if ( /not available|no availability|is not available|no service|not available in your|sorry/.test(bodyText) ) {
      availability = "❌ No disponible";
    } else if ( /available|great news|is available|service available|availability:/.test(bodyText) ) {
      availability = "✅ Disponible";
    }

    // cerrar y devolver
    await page.close();
    await context.close();

    return res.json({
      address: suggestions[idx] || addressRaw,
      suggestions,
      chosenIndex: option,
      coverage: availability,
      plans
    });

  } catch (err) {
    try { await page.close(); } catch(e){}
    try { await context.close(); } catch(e){}
    console.error("ERROR /coverage:", err);
    return res.status(500).json({ error: "Fallo al consultar cobertura", details: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening http://localhost:${PORT}`);
});

process.on("SIGINT", async ()=> { await closeBrowser(); process.exit(0); });
process.on("SIGTERM", async ()=> { await closeBrowser(); process.exit(0); });
