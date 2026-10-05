<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
const props = defineProps<{ entries: string[] }>();
const viewport = ref<HTMLOListElement>();
const following = ref(true);
function inspectPosition(): void {
  const list = viewport.value;
  if (list) following.value = list.scrollHeight - list.clientHeight - list.scrollTop <= 32;
}
function showLatest(): void {
  following.value = true;
  if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight;
}
watch(() => props.entries.length, async () => {
  await nextTick();
  if (following.value) showLatest();
});
</script>

<template>
  <section class="recent-activity" aria-label="Recent activity">
    <header><span>Recent activity <small>No audio content</small></span>
      <button v-if="!following" type="button" @click="showLatest">Show latest</button>
    </header>
    <ol ref="viewport" tabindex="0" aria-label="Test activity history" @scroll="inspectPosition">
      <li v-for="(entry, index) in entries" :key="index">{{ entry }}</li>
      <li v-if="!entries.length">Waiting for the voice lab…</li>
    </ol>
  </section>
</template>

<style scoped>
.recent-activity{grid-column:1/-1;min-width:0;border-top:1px solid #d0e0f3;padding-top:17px;color:#62779f}
header{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px;padding:6px 12px;background:#f4f8ff;border-radius:8px 8px 0 0;font-size:11px}
small{margin-left:10px;color:#7182a6}
ol{box-sizing:border-box;max-height:14rem;min-height:3.2rem;overflow-y:auto;overscroll-behavior:contain;overflow-wrap:anywhere;margin:0;padding:8px 12px;list-style:none;background:#f4f8ff;border-radius:0 0 8px 8px;font:11px/1.6 ui-monospace,SFMono-Regular,monospace}
li{padding:3px 0}li:last-child{color:#2354d7}
button{border:1px solid #bfd3ee;border-radius:6px;background:#fff;color:#2354d7;padding:5px 9px;cursor:pointer}
ol:focus-visible,button:focus-visible{outline:2px solid #2354d7;outline-offset:2px}
</style>
