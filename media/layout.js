import { WIDE_QUERY } from './sessions.js';

export function followTranscript(transcript) {
  return (
    !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60
  );
}

export function chatFrame({ wide, header, banner, manager, sidebar, transcript, footer }) {
  return wide
    ? `<div class="chat-shell"><div class="chat-pane">${header}${banner}${transcript}${footer}</div>${sidebar}</div>`
    : `${header}${banner}${manager}${transcript}${footer}`;
}

export function removeChatSurface() {
  document.querySelector('.transcript')?.remove();
  document.querySelector('#composer')?.closest('footer')?.remove();
}

export function restoreTranscript(transcript, follow, scroll, dockScroll) {
  transcript.scrollTop = follow ? transcript.scrollHeight : scroll;
  const dock = document.querySelector('.dock-sections');
  if (dock) dock.scrollTop = dockScroll;
}

export function watchLayout(render, remember) {
  if (typeof window.matchMedia !== 'function') return;
  window.matchMedia(WIDE_QUERY).addEventListener?.('change', () => {
    render();
    remember();
  });
}
