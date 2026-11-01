"""验证 NPC 提示词 API 隔离"""
import requests

for npc_id in ['xiaoshuai', 'xiaomei', 'dagou']:
    resp = requests.get(f'http://127.0.0.1:8000/api/npc/prompts?npc_id={npc_id}')
    data = resp.json()
    soul = next((p for p in data if p['prompt_type'] == 'soul' and p['npc_id'] == npc_id), None)
    tools = next((p for p in data if p['prompt_type'] == 'tools' and p['npc_id'] == npc_id), None)
    shared_count = len([p for p in data if p['npc_id'] == 'shared'])
    
    soul_preview = soul['content'][:60].replace('\n', ' ') if soul else 'MISSING'
    tools_preview = tools['content'][:60].replace('\n', ' ') if tools else 'MISSING'
    
    print(f"=== {npc_id} ===")
    print(f"  soul:  {soul_preview}...")
    print(f"  tools: {tools_preview}...")
    print(f"  shared prompts: {shared_count}")
    print()
