// node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as g from "./geo.js";

test("tile <-> lon/lat round trip; Nelson is z15 5707/11184", () => {
  assert.equal(Math.floor(g.lonToTileX(-117.2913, 15)), 5707);
  assert.equal(Math.floor(g.latToTileY(49.4936, 15)), 11184);
  assert.ok(Math.abs(g.tileYToLat(g.latToTileY(49.4936, 12), 12) - 49.4936) < 1e-9);
  assert.ok(Math.abs(g.tileXToLon(g.lonToTileX(-117.2913, 12), 12) + 117.2913) < 1e-9);
});

test("local frame round trip and scale", () => {
  const f = g.localFrame(-117.29, 49.49);
  const [x, z] = f.toLocal(-117.28, 49.48);
  assert.ok(x > 700 && x < 750 && z > 1100 && z < 1110); // ~724 m east, ~1105 m south
  const [lon, lat] = f.toLonLat(x, z);
  assert.ok(Math.abs(lon + 117.28) < 1e-9 && Math.abs(lat - 49.48) < 1e-9);
});

test("tilesAround includes own tile and grows with radius", () => {
  const f = g.localFrame(-117.2913, 49.4936);
  const near = g.tilesAround(-117.2913, 49.4936, 15, 100, f);
  assert.ok(near.some(([, x, y]) => x === 5707 && y === 11184));
  assert.ok(g.tilesAround(-117.2913, 49.4936, 15, 1500, f).length > near.length);
});

test("rings, point in ring, terrain rgb", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(g.ringArea(sq), 100);
  assert.ok(g.pointInRing(5, 5, sq) && !g.pointInRing(15, 5, sq));
  assert.equal(Math.round(g.rgbToHeight(1, 134, 160)), 0);
  const hole = [[2, 2], [2, 8], [8, 8], [8, 2]]; // reversed winding
  assert.ok(!g.inPolygon(5, 5, [sq, hole]) && g.inPolygon(1, 1, [sq, hole]));
  assert.ok(g.inPolygon(5, 5, [sq, sq])); // overlapping outers stay filled (even-odd would cancel)
});

test("medians: opposite one-ways 10 m apart pair up; same-way or far ones don't", () => {
  const north = { ax: 0, az: 0, bx: 0, bz: -100, name: "Dolores St" }, south = { ax: 10, az: -90, bx: 10, bz: 10, name: "Dolores St" };
  const m = g.medianQuads([north, south]);
  assert.equal(m.length, 1);
  assert.ok(Math.abs(m[0].width - 10) < 1e-6);
  assert.equal(g.medianQuads([north, { ...north, ax: 10, bx: 10 }]).length, 0); // same direction
  assert.equal(g.medianQuads([north, { ...south, ax: 60, bx: 60 }]).length, 0); // 60 m: separate streets
  assert.equal(g.medianQuads([north, { ...south, name: "Guerrero St" }]).length, 0);
});
