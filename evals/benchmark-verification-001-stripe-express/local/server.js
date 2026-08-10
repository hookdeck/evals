const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/orders', (req, res) => {
  console.log('order received', req.body.id);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`orders-api listening on ${PORT}`);
});
