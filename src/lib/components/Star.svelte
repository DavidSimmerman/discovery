<script lang="ts">
  type Props = {
    fill: 'empty' | 'full';
    size: number;
  };

  let { fill, size }: Props = $props();

  const FILLED = '#1DB954';
  const EMPTY_STROKE = '#444';

  // Classic 5-point star path on a 24x24 viewBox.
  const STAR_PATH =
    'M12 2.5l2.92 5.92 6.53.95-4.72 4.6 1.11 6.5L12 17.9l-5.84 3.07 1.11-6.5-4.72-4.6 6.53-.95L12 2.5z';
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
  style="display:block"
>
  <path
    d={STAR_PATH}
    fill={fill === 'full' ? FILLED : 'none'}
    stroke={fill === 'full' ? FILLED : EMPTY_STROKE}
    stroke-width="1.5"
    stroke-linejoin="round"
  />
</svg>
