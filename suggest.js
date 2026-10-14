// 站名输入补全：输入框 + 下拉候选（最多 20 条，子串匹配）
export function attachSuggest(input, ul, names, onPick) {
  let active = -1;

  const hide = () => { ul.hidden = true; ul.innerHTML = ''; active = -1; };

  const render = () => {
    const q = input.value.trim();
    const hits = [];
    for (const name of names()) {
      if (q === '' || name.includes(q) || name.toUpperCase().includes(q.toUpperCase())) hits.push(name);
      if (hits.length >= 20) break;
    }
    if (hits.length === 0) return hide();
    ul.innerHTML = '';
    for (const name of hits) {
      const li = document.createElement('li');
      li.textContent = name;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = name;
        hide();
        onPick?.(name);
      });
      ul.appendChild(li);
    }
    ul.hidden = false;
    active = -1;
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(hide, 120));
  // 点击输入框与下拉之外的任何地方立即收起，避免下拉浮层挡住下面的按钮
  document.addEventListener('mousedown', (e) => {
    if (e.target !== input && !ul.contains(e.target)) hide();
  });
  input.addEventListener('keydown', (e) => {
    if (ul.hidden) return;
    const items = [...ul.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = e.key === 'ArrowDown'
        ? (active + 1) % items.length
        : (active - 1 + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      input.value = items[active].textContent;
      hide();
    } else if (e.key === 'Escape') {
      hide();
    }
  });
}
