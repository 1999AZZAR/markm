<script>
  let { folderName = '', files = [], activePath = null, onSelect, onOpenFolder } = $props();
</script>

<aside class="sidebar">
  <div class="head">
    <span class="name" title={folderName}>{folderName || 'No folder'}</span>
    <button class="open" title="Open folder" aria-label="Open folder" onclick={() => onOpenFolder?.()}>Open</button>
  </div>
  <div class="list">
    {#if files.length === 0}
      <div class="empty">No markdown files</div>
    {:else}
      {#each files as f (f.path)}
        <button
          class="item"
          class:active={f.path === activePath}
          title={f.name}
          onclick={() => onSelect?.(f.path)}
        >{f.name}</button>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    width: 220px;
    flex: none;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 6px 6px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }
  .head .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .head .open {
    flex: none;
    font-size: 11px;
    font-weight: 400;
    padding: 1px 8px;
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .head .open:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .list {
    flex: 1;
    overflow: auto;
    padding: 4px;
  }
  .item {
    display: block;
    width: 100%;
    text-align: left;
    font-size: 13px;
    padding: 5px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item:hover { background: var(--sel); }
  .item.active {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .empty {
    padding: 10px 12px;
    font-size: 12px;
    color: var(--muted);
  }
</style>
