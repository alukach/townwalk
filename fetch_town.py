# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=1.1"]
# ///
"""Fetch open data for a bbox from source.coop and write media/<name>.json in local metres.

    uv run fetch_town.py nelson -117.300 49.488 -117.280 49.500

Coordinates: origin at bbox centre, x = east, z = south (so north is -z, raea's "forward"), metres.
"""
import json, math, sys
from pathlib import Path
import duckdb

OVERTURE = "s3://fused/overture/2026-04-15-0"  # ponytail: pinned release; 2026-05-20 has no buildings on the mirror yet


def main(name: str, w: float, s: float, e: float, n: float) -> None:
    lon0, lat0 = (w + e) / 2, (s + n) / 2
    kx, kz = 111320 * math.cos(math.radians(lat0)), 110540  # ponytail: equirectangular, fine at town scale

    def local(lon, lat):
        return [round((lon - lon0) * kx, 2), round((lat0 - lat) * kz, 2)]

    con = duckdb.connect()
    con.execute("""INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;
        SET s3_endpoint='data.source.coop'; SET s3_url_style='path'; SET s3_region='us-west-2';
        SET s3_access_key_id=''; SET s3_secret_access_key='';""")
    rows = con.execute(f"""
        SELECT ST_AsGeoJSON(geometry), height, num_floors, class
        FROM read_parquet('{OVERTURE}/theme=buildings/type=building/part=*/*.parquet', hive_partitioning=1)
        WHERE bbox.xmin >= ? AND bbox.xmax <= ? AND bbox.ymin >= ? AND bbox.ymax <= ?""", [w, e, s, n]).fetchall()

    buildings = []
    for geo, height, floors, cls in rows:
        g = json.loads(geo)
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        h = height or (floors * 3.2 if floors else 6.0)  # ponytail: default 6 m when Overture has no height
        for poly in polys:
            ring = [local(*pt) for pt in poly[0][:-1]]  # exterior ring only; courtyards ignored
            if len(ring) >= 3:
                buildings.append({"h": round(h, 1), "c": cls, "pts": ring})

    out = Path("media") / f"{name}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"name": name, "bbox": [w, s, e, n], "origin": [lon0, lat0], "buildings": buildings}))
    print(f"{out}: {len(buildings)} buildings")


if __name__ == "__main__":
    a = sys.argv[1:]
    main(a[0], *map(float, a[1:5]))
