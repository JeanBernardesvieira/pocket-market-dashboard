const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <html>
      <head>
        <title>Pocket Market Dashboard</title>
      </head>
      <body style="font-family: Arial; padding: 40px;">
        <h1>Pocket Market Dashboard</h1>
        <p>Sistema iniciado com sucesso.</p>
        <p>Loja inicial: agulhas_negras</p>
      </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
