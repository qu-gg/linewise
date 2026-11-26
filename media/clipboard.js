const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const maximumImageBytes = 524_288;

function clipboardImageFiles(event) {
  const clipboard = event.clipboardData;
  if (event.target.id !== 'prompt' || !clipboard) return [];
  return [...clipboard.items]
    .filter((item) => item.kind === 'file' && imageTypes.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file) => file);
}

function insertText(text, controls) {
  const field = document.querySelector('#prompt');
  if (!field) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const next = field.value.slice(0, start) + text + field.value.slice(end);
  const position = start + text.length;
  field.value = next;
  field.setSelectionRange(position, position);
  controls.setDraft(next);
  controls.remember();
  const submitButton = document.querySelector('.send');
  if (submitButton) submitButton.disabled = !controls.canSubmit(next);
}

function imageData(file) {
  return new Promise((resolve, reject) => {
    if (!imageTypes.has(file.type)) {
      reject(new Error('Paste PNG, JPEG or WebP images only.'));
      return;
    }
    if (!file.size || file.size > maximumImageBytes) {
      reject(new Error('Pasted images must be at most 512 KiB each.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read a pasted image.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const marker = `data:${file.type};base64,`;
      if (!result.startsWith(marker)) {
        reject(new Error('Could not decode a pasted image.'));
        return;
      }
      resolve({ mimeType: file.type, data: result.slice(marker.length) });
    };
    reader.readAsDataURL(file);
  });
}

async function decodedImages(files, controls) {
  const images = [];
  for (const file of files) {
    try {
      images.push(await imageData(file));
    } catch (error) {
      controls.setNotice(error.message);
    }
  }
  return images;
}

export async function pasteImages(event, controls) {
  const files = clipboardImageFiles(event);
  if (!files.length) return;
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  if (text) insertText(text, controls);
  if (controls.working()) {
    controls.setNotice('Wait for the current operation before adding pasted images.');
    controls.render();
    return;
  }
  const images = await decodedImages(files, controls);
  if (!images.length) {
    controls.render();
    controls.focus();
    return;
  }
  controls.setNotice('');
  controls.send(images);
  controls.focus();
}
