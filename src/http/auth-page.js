'use strict';

function renderAuthErrorPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorization error</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #071018;
    color: #e8eef7;
    font: 16px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .auth-backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: #071018;
    padding: 24px;
  }
  .auth-modal {
    width: min(520px, 100%);
    border: 1px solid #263547;
    border-radius: 10px;
    background: #111a26;
    box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
    padding: 28px;
  }
  h1 { margin: 0 0 10px; font-size: 22px; }
  p { margin: 0; color: #aab6c6; }
</style>
</head>
<body>
  <div class="auth-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="authTitle">
    <section class="auth-modal">
      <h1 id="authTitle">Authorization error</h1>
      <p>Missing or invalid access token. Open Codex Web using the URL printed by the running server.</p>
    </section>
  </div>
</body>
</html>`;
}

module.exports = { renderAuthErrorPage };
