import requests
import json

URL = 'https://hjtxdyuevxcezxzbiiqk.supabase.co/rest/v1'
KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqdHhkeXVldnhjZXp4emJpaXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1MjU5MDEsImV4cCI6MjA5NTEwMTkwMX0.ZiKUw1db5pDRYto-hLGut3rdrzxVfRN36ouX4AjB5AQ'
HEADERS = {
    'apikey': KEY,
    'Authorization': f'Bearer {KEY}'
}

# Fetch transaction
res_tx = requests.get(f'{URL}/transactions?reference_number=eq.9678735915', headers=HEADERS)
tx_data = res_tx.json()
print("Transaction Data:")
print(json.dumps(tx_data, indent=2))

# Fetch mapping for Spring 26 Fees
res_map = requests.get(f'{URL}/item_mappings?item_name=ilike.*Spring%2026%20Fees*', headers=HEADERS)
map_data = res_map.json()
print("\nMapping Data:")
print(json.dumps(map_data, indent=2))

