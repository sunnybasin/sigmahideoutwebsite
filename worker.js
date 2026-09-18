{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "sigmahideoutwebsite",
  "compatibility_date": "2026-09-06",
  "main": "worker.js",
  "assets": {
    "directory": ".",
    "binding": "ASSETS"
  },
  "kv_namespaces": [
    {
      "binding": "GALLERY_KV",
      "id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
    }
  ]
}
