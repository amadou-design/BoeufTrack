const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'BoeufTrack API ok' }));

app.post('/analyze', async (req, res) => {
  try {
    const { image_b64, breed, last_weight, days_since, ref_weight } = req.body;
    if (!image_b64) return res.status(400).json({ error: 'image_b64 requis' });
    const bnames = { zebu:'Zebu Sahelien', ndama:"N'Dama", gobra:'Gobra', azawak:'Azawak', autre:'Race locale' };
    const prompt = [`Expert zootechnicien bovins africains. Analyse ce boeuf race ${bnames[breed]||'locale'}.`, ref_weight?`Poids reference: ${ref_weight}kg.`:'', last_weight?`Derniere pesee: ${last_weight}kg il y a ${days_since}j.`:'', `Reponds UNIQUEMENT avec ce JSON:\n{"poids":250,"poids_min":220,"poids_max":280,"bcs":3.5,"confiance":70,"observations":"morphologie","conseil":"action"}`].filter(Boolean).join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image_b64 } }, { type: 'text', text: prompt }] }] })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const txt = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
    let parsed = null;
    for (const fn of [()=>JSON.parse(txt), ()=>JSON.parse(txt.replace(/```json\n?|\n?```/gi,'')), ()=>{const m=txt.match(/\{[\s\S]+\}/);return m?JSON.parse(m[0]):null;}]) { try{parsed=fn();if(parsed?.poids)break;}catch{} }
    if (!parsed?.poids) { const n=txt.match(/\b([12]\d{2}|[34]\d{2})\b/g); const p=n?+n[0]:250; parsed={poids:p,poids_min:p-25,poids_max:p+25,bcs:3,confiance:45,observations:'Analyse effectuee.',conseil:'Calibre avec pesee reelle.'}; }
    res.json({ success: true, result: parsed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 8080
, () => console.log('BoeufTrack API running'));
