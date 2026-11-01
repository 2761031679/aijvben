import sqlite3
db = sqlite3.connect('/opt/turtlesoup/data/turtlesoup.db')
for r in db.execute("SELECT npc_id, prompt_type, content FROM npc_prompts WHERE npc_id IN ('xiaoshuai','xiaomei','dagou') ORDER BY npc_id, prompt_type"):
    print(f"=== {r[0]}/{r[1]} ({len(r[2])} chars) ===")
    print(r[2])
    print()
