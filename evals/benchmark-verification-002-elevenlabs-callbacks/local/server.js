const express = require('express');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Transcription callbacks land here. Right now we just log them; the
// transcript pipeline is wired up separately.
app.post('/transcripts', (req, res) => {
  console.log('transcript callback', req.body && req.body.type);
  res.sendStatus(200);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`transcripts-service on ${PORT}`));
