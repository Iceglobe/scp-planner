fetch("http://localhost:5173/api/inventory/alerts")
  .then(r => r.text())
  .then(console.log)
  .catch(console.error);
