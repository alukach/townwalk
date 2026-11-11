// Place search: Photon (OSM-based geocoder, komoot) or a typed "lat, lon". Only what's typed is sent to Photon.
export function setupSearch(onPick) {
  const input = document.getElementById("search"), list = document.getElementById("results");
  let timer = 0, seq = 0;
  const show = (items) => {
    list.innerHTML = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = it.label;
      li.onpointerdown = (e) => { e.preventDefault(); pick(it); };
      list.append(li);
    }
    list.hidden = !items.length;
  };
  const pick = (it) => { show([]); input.value = it.name; input.blur(); onPick(it.lon, it.lat); };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    const ll = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (ll) return show([{ label: `Go to ${ll[1]}, ${ll[2]}`, name: q, lat: +ll[1], lon: +ll[2] }]);
    if (q.length < 3) return show([]);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`);
        const { features } = await r.json();
        if (mine !== seq) return; // a newer query is on its way
        show(features.map((f) => {
          const p = f.properties, [lon, lat] = f.geometry.coordinates;
          return { name: p.name, lon, lat, label: [p.name, p.city !== p.name && p.city, p.state, p.country].filter(Boolean).join(", ") };
        }));
      } catch { show([]); }
    }, 300);
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing never walks or opens the map
    if (e.key === "Enter") list.firstElementChild?.dispatchEvent(new PointerEvent("pointerdown"));
    if (e.key === "Escape") { show([]); input.blur(); }
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("blur", () => setTimeout(() => show([]), 150));
}
