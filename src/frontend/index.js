const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`[Frontend] RM Portal listening on port ${PORT}`);
    console.log(`[Frontend] Access the UI at http://localhost:${PORT}`);
});
