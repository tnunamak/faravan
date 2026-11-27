// <use href="#name"> points at the sprite that main.jsx mounts once (ds/sprite.jsx).
export function Icon({name, size, label, ...rest}) {
  const cls = 'i' + (size ? ' ' + size : '') + (rest.class ? ' ' + rest.class : '');
  return (
    <svg {...rest} class={cls} focusable="false"
      {...(label ? {role: 'img', 'aria-label': label} : {'aria-hidden': 'true'})}>
      <use href={'#' + name} />
    </svg>
  );
}

export function Spinner() {
  return <span class="spinner" aria-hidden="true" />;
}
