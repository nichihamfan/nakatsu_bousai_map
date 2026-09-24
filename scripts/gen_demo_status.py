"""
受入状況のサンプルデータを生成する（デモ用）。
本番では、この形式のファイルを app/admin.html（ローカル編集ツール）で
避難所担当者からの報告に基づき手動更新し、配信先へ差し替える運用を想定する。
"""
import json
import random

with open("../public/data/shelters.json", encoding="utf-8") as f:
    shelters = json.load(f)

random.seed(42)

# 中津地域（市街地中心部、デモで見やすい範囲）を優先的にサンプルへ含める
candidates = [s for s in shelters if s["region"] == "中津地域" and s["type"] == "general"]
random.shuffle(candidates)

status_pool = (
    ["open"] * 10
    + ["crowded"] * 5
    + ["full"] * 3
)
random.shuffle(status_pool)

entries = {}
TIMESTAMPS = [
    "2026-09-22T09:15:00+09:00",
    "2026-09-22T09:40:00+09:00",
    "2026-09-22T10:05:00+09:00",
    "2026-09-22T10:30:00+09:00",
]

for i, s in enumerate(candidates[: len(status_pool)]):
    entries[str(s["id"])] = {
        "status": status_pool[i],
        "updated_at": random.choice(TIMESTAMPS),
    }

out = {
    "generated_note": "これはデモ用のサンプルデータです。実際の避難所開設状況ではありません。",
    "entries": entries,
}

with open("../public/data/shelter_status.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print("wrote", len(entries), "status entries")
for sid, v in list(entries.items())[:6]:
    name = next(s["name"] for s in shelters if str(s["id"]) == sid)
    print(f"  id={sid} {name}: {v['status']}")
