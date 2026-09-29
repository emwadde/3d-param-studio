const el = document.getElementById('catalogue');

async function load() {
  let items;
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    items = await res.json();
  } catch (e) {
    el.innerHTML = `<p class="error">Could not load the catalogue: ${e.message}</p>`;
    return;
  }
  if (!items.length) {
    el.innerHTML = '<p class="muted">No models yet — add a .json file to public/models.</p>';
    return;
  }
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const item of items) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = `/studio.html?model=${encodeURIComponent(item.id)}`;
    a.innerHTML = `<div class="card-thumb" aria-hidden="true">🪑</div><div class="card-body"><h2>${item.name}</h2><p class="muted">${item.paramCount} parameter${item.paramCount === 1 ? '' : 's'}</p></div>`;
    grid.appendChild(a);
  }
  el.appendChild(grid);
}

load();
