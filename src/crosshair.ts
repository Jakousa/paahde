// The dot in the middle of the screen (hidden while dead).
export function addCrosshair() {
  const style = document.createElement('style');
  style.textContent = `
    #crosshair { position: fixed; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
      border-radius: 50%; background: rgba(255,255,255,.85); box-shadow: 0 0 0 1px rgba(0,0,0,.35);
      pointer-events: none; }
    body.down #crosshair { display: none; }`;
  document.head.appendChild(style);
  const cross = document.createElement('div');
  cross.id = 'crosshair';
  document.body.append(cross);
}
