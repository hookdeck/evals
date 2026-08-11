const { appendFileSync } = require('node:fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());

// Every delivery is appended here so the team can see what arrived while
// they were working on the handler.
const RECEIVED_LOG = process.env.RECEIVED_LOG || '/tmp/received.log';

app.post('/notifications', (req, res) => {
  appendFileSync(RECEIVED_LOG, `${JSON.stringify(req.body)}\n`);
  console.log('notification received', req.body?.id);
  res.sendStatus(200);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`notifications-service listening on ${PORT}`);
});
