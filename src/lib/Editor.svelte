<script>
  import { onMount } from 'svelte';
  import { createEditor, setEditorDoc } from './editor.js';

  let { value = '', onChange, onCursor } = $props();

  let el;
  let view;
  // Tracks the last value we know the editor holds, so an external `value`
  // change (a file load) pushes into CodeMirror, but the user's own typing
  // (which flows out through onChange) doesn't loop back and reset the cursor.
  let lastKnown = '';

  onMount(() => {
    lastKnown = value;
    view = createEditor(el, {
      doc: value,
      onChange: (v) => {
        lastKnown = v;
        onChange?.(v);
      },
      onCursor: (line, col) => onCursor?.(line, col),
    });
    return () => view?.destroy();
  });

  $effect(() => {
    if (view && value !== lastKnown) {
      lastKnown = value;
      setEditorDoc(view, value);
    }
  });
</script>

<div class="editor" bind:this={el}></div>

<style>
  .editor {
    height: 100%;
    overflow: hidden;
  }
</style>
