import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Transport from '$lib/components/Transport.svelte';

describe('<Transport />', () => {
  it('renders Play icon when paused, calls ontoggle on click', async () => {
    const ontoggle = vi.fn();
    const { getByLabelText } = render(Transport, {
      props: { paused: true, ontoggle, onnext: vi.fn(), onprev: vi.fn() },
    });
    await fireEvent.click(getByLabelText(/play/i));
    expect(ontoggle).toHaveBeenCalled();
  });

  it('next/prev buttons fire their callbacks', async () => {
    const onnext = vi.fn();
    const onprev = vi.fn();
    const { getByLabelText } = render(Transport, {
      props: { paused: false, ontoggle: vi.fn(), onnext, onprev },
    });
    await fireEvent.click(getByLabelText(/next/i));
    await fireEvent.click(getByLabelText(/previous/i));
    expect(onnext).toHaveBeenCalled();
    expect(onprev).toHaveBeenCalled();
  });
});
