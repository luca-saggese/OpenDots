const characters = [
  '01-bunny-flower',
  '02-lemon-leaf',
  '03-blue-cloud',
  '04-bear-scarf',
  '05-mint-drop',
  '06-blue-penguin',
  '07-purple-cat',
  '08-orange-flower',
  '09-green-monster',
  '10-pink-heart',
  '11-puppy',
  '12-mint-wink',
  '13-pink-flower',
  '14-blue-star',
  '15-orange-headphones',
  '16-green-alien',
  '17-mushroom',
  '18-lavender-ghost',
  '19-calico-cat',
  '20-blue-angel',
  '21-purple-king',
  '22-mint-pear',
  '23-pink-axolotl',
  '24-avocado',
  '25-yellow-star',
] as const;

/** Stable identity keeps each specialist recognizable across views and reloads. */
function characterFor(identity?: string) {
  if (!identity) return characters[2];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
}) {
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      <img
        className="dot-body"
        src={`/dots/${characterFor(identity)}.png`}
        alt={decorative ? '' : `${name} is ${state}`}
        width={512}
        height={512}
        draggable={false}
      />
    </span>
  );
}
