const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const previewCanvas = document.querySelector("#previewCanvas");
const emptyState = document.querySelector("#emptyState");
const paddingInput = document.querySelector("#paddingInput");
const paddingValue = document.querySelector("#paddingValue");
const sensitivityInput = document.querySelector("#sensitivityInput");
const sensitivityValue = document.querySelector("#sensitivityValue");
const transparentInput = document.querySelector("#transparentInput");
const scanButton = document.querySelector("#scanButton");
const downloadAllButton = document.querySelector("#downloadAllButton");
const statusEl = document.querySelector("#status");
const stickerGrid = document.querySelector("#stickerGrid");
const countLabel = document.querySelector("#countLabel");

let sourceImage = null;
let sourceName = "sticker";
let sourceCanvas = null;
let sourceCtx = null;
let currentStickers = [];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setBusy(isBusy) {
  scanButton.disabled = isBusy || !sourceImage;
  downloadAllButton.disabled = isBusy || currentStickers.length === 0;
}

function updateLabels() {
  paddingValue.textContent = `${paddingInput.value} px`;
  sensitivityValue.textContent = sensitivityInput.value;
}

function distanceFromWhite(r, g, b) {
  const dr = 255 - r;
  const dg = 255 - g;
  const db = 255 - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function makeMask(imageData, threshold) {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);

  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    mask[pixel] = distanceFromWhite(data[i], data[i + 1], data[i + 2]) > threshold ? 1 : 0;
  }

  return { mask, width, height };
}

function openMask(maskInfo) {
  const { mask, width, height } = maskInfo;
  const output = new Uint8Array(mask.length);
  const neighborCount = (x, y) => {
    let count = 0;
    for (let yy = y - 1; yy <= y + 1; yy += 1) {
      for (let xx = x - 1; xx <= x + 1; xx += 1) {
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        count += mask[yy * width + xx];
      }
    }
    return count;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      output[index] = mask[index] && neighborCount(x, y) >= 2 ? 1 : 0;
    }
  }

  return { mask: output, width, height };
}

function connectedComponents(maskInfo) {
  const { mask, width, height } = maskInfo;
  const visited = new Uint8Array(mask.length);
  const components = [];
  const queue = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    let sumX = 0;
    let sumY = 0;

    queue.length = 0;
    queue.push(start);
    visited[start] = 1;

    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head];
      const x = index % width;
      const y = Math.floor(index / width);

      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 1);
      maxY = Math.max(maxY, y + 1);

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length) continue;
        if ((next === index - 1 && x === 0) || (next === index + 1 && x === width - 1)) {
          continue;
        }
        if (mask[next] && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    if (area >= 45) {
      components.push({
        box: [minX, minY, maxX, maxY],
        area,
        center: [sumX / area, sumY / area],
      });
    }
  }

  return components;
}

function boxDistance(a, b) {
  const dx = Math.max(b[0] - a[2], a[0] - b[2], 0);
  const dy = Math.max(b[1] - a[3], a[1] - b[3], 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function addPadding(box, width, height, padding) {
  return [
    clamp(box[0] - padding, 0, width),
    clamp(box[1] - padding, 0, height),
    clamp(box[2] + padding, 0, width),
    clamp(box[3] + padding, 0, height),
  ];
}

function groupRows(items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    let placed = false;
    for (const row of rows) {
      const rowY1 = Math.min(...row.map((entry) => entry.box[1]));
      const rowY2 = Math.max(...row.map((entry) => entry.box[3]));
      const overlap = Math.min(item.box[3], rowY2) - Math.max(item.box[1], rowY1);
      if (overlap > Math.min(item.box[3] - item.box[1], rowY2 - rowY1) * 0.35) {
        row.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([item]);
  }
  return rows.sort((a, b) => averageY(a) - averageY(b));
}

function averageY(row) {
  return row.reduce((sum, item) => sum + (item.box[1] + item.box[3]) / 2, 0) / row.length;
}

function trimOverlaps(boxes, padding) {
  const rows = groupRows(boxes.map((box) => ({ box })));
  const output = [];

  for (const row of rows) {
    const sorted = row.map((item) => [...item.box]).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const left = sorted[i];
      const right = sorted[i + 1];
      const overlap = left[2] - right[0];
      if (overlap > Math.max(6, Math.floor(padding / 2))) {
        const boundary = Math.floor((left[2] + right[0]) / 2);
        left[2] = boundary;
        right[0] = boundary;
      }
    }
    output.push(...sorted);
  }

  return output;
}

function findStickerBoxes(imageData, threshold, padding) {
  const width = imageData.width;
  const height = imageData.height;
  const components = connectedComponents(openMask(makeMask(imageData, threshold)));
  const anchorMinArea = width * height * 0.0012;
  const anchors = components.filter((component) => {
    const [x1, y1, x2, y2] = component.box;
    return (
      component.area >= anchorMinArea &&
      x2 - x1 >= width * 0.07 &&
      y2 - y1 >= height * 0.07
    );
  });

  if (anchors.length === 0) return [];

  const groupGap = Math.max(70, Math.floor(Math.min(width, height) * 0.12));
  const lowerGap = Math.max(22, Math.floor(Math.min(width, height) * 0.035));
  const grouped = anchors.map((anchor) => ({ anchor, components: [anchor] }));

  for (const component of components) {
    let bestIndex = -1;
    let bestDistance = Infinity;

    anchors.forEach((anchor, index) => {
      if (component === anchor) {
        bestIndex = index;
        bestDistance = 0;
        return;
      }

      if (component.box[1] - anchor.box[3] > lowerGap) return;
      const distance = boxDistance(anchor.box, component.box);
      if (distance <= groupGap && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });

    if (bestIndex >= 0 && !grouped[bestIndex].components.includes(component)) {
      grouped[bestIndex].components.push(component);
    }
  }

  const groups = grouped.map((group) => {
    const xs1 = group.components.map((component) => component.box[0]);
    const ys1 = group.components.map((component) => component.box[1]);
    const xs2 = group.components.map((component) => component.box[2]);
    const ys2 = group.components.map((component) => component.box[3]);
    return {
      box: [Math.min(...xs1), Math.min(...ys1), Math.max(...xs2), Math.max(...ys2)],
      anchorBox: group.anchor.box,
      center: group.anchor.center,
    };
  });

  const rows = groupRows(groups);
  const adjusted = [];
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.center[0] - b.center[0]);
    sorted.forEach((group, index) => {
      let [x1, y1, x2, y2] = group.box;
      const [ax1, , ax2] = group.anchorBox;

      if (index > 0) {
        const boundary = Math.floor((sorted[index - 1].center[0] + group.center[0]) / 2);
        if (x1 < boundary && sorted[index - 1].box[2] > x1) {
          x1 = Math.min(Math.max(x1, boundary), ax1 - 8);
        }
      }

      if (index < sorted.length - 1) {
        const boundary = Math.floor((group.center[0] + sorted[index + 1].center[0]) / 2);
        if (x2 > boundary && sorted[index + 1].box[0] < x2) {
          x2 = Math.max(Math.min(x2, boundary), ax2 + 8);
        }
      }

      adjusted.push([x1, y1, x2, y2]);
    });
  }

  return trimOverlaps(
    adjusted
      .filter((box) => (box[2] - box[0]) * (box[3] - box[1]) >= width * height * 0.01)
      .map((box) => addPadding(box, width, height, padding)),
    padding,
  );
}

function drawPreview(boxes) {
  const canvas = previewCanvas;
  const ctx = canvas.getContext("2d");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  ctx.drawImage(sourceCanvas, 0, 0);

  ctx.lineWidth = Math.max(3, Math.floor(canvas.width / 320));
  ctx.strokeStyle = "#06a12f";
  ctx.fillStyle = "#068828";
  ctx.font = `800 ${Math.max(26, Math.floor(canvas.width / 32))}px system-ui`;

  boxes.forEach((box, index) => {
    const [x1, y1, x2, y2] = box;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillText(String(index + 1), x1 + 10, y1 + 34);
  });
}

function cropToBlob(box, transparent) {
  const [x1, y1, x2, y2] = box.map(Math.round);
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(sourceCanvas, x1, y1, width, height, 0, 0, width, height);

  if (transparent) {
    const imageData = ctx.getImageData(0, 0, width, height);
    removeEdgeWhite(imageData);
    ctx.putImageData(imageData, 0, 0);
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve({ blob, url: URL.createObjectURL(blob) }), "image/png");
  });
}

function removeEdgeWhite(imageData) {
  const { width, height, data } = imageData;
  const visited = new Uint8Array(width * height);
  const queue = [];

  const isNearWhite = (index) => {
    const offset = index * 4;
    return data[offset] >= 248 && data[offset + 1] >= 248 && data[offset + 2] >= 248;
  };

  for (let x = 0; x < width; x += 1) {
    queue.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    queue.push(y * width, y * width + width - 1);
  }

  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    if (index < 0 || index >= width * height || visited[index] || !isNearWhite(index)) continue;
    visited[index] = 1;
    const x = index % width;
    if (x > 0) queue.push(index - 1);
    if (x < width - 1) queue.push(index + 1);
    if (index >= width) queue.push(index - width);
    if (index < width * (height - 1)) queue.push(index + width);
  }

  for (let index = 0; index < visited.length; index += 1) {
    if (visited[index]) data[index * 4 + 3] = 0;
  }
}

async function renderResults(boxes) {
  currentStickers.forEach((sticker) => URL.revokeObjectURL(sticker.url));
  currentStickers = [];
  stickerGrid.innerHTML = "";

  const transparent = transparentInput.checked;
  for (let index = 0; index < boxes.length; index += 1) {
    const sticker = await cropToBlob(boxes[index], transparent);
    const filename = `${sourceName}_sticker_${String(index + 1).padStart(2, "0")}.png`;
    currentStickers.push({ ...sticker, filename });

    const card = document.createElement("article");
    card.className = "sticker-card";
    card.innerHTML = `
      <img src="${sticker.url}" alt="Sticker ${index + 1}" />
      <a href="${sticker.url}" download="${filename}">Tải PNG ${index + 1}</a>
    `;
    stickerGrid.appendChild(card);
  }

  countLabel.textContent = `${currentStickers.length} file`;
  downloadAllButton.disabled = currentStickers.length === 0;
}

async function scanImage() {
  if (!sourceImage) return;
  setBusy(true);
  setStatus("Đang quét ảnh...");

  await new Promise((resolve) => requestAnimationFrame(resolve));

  const padding = Number(paddingInput.value);
  const threshold = Number(sensitivityInput.value);
  const imageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const boxes = findStickerBoxes(imageData, threshold, padding);

  drawPreview(boxes);
  await renderResults(boxes);

  emptyState.hidden = true;
  setStatus(
    boxes.length
      ? `Đã tách ${boxes.length} sticker. Có thể tải từng file hoặc tải tất cả.`
      : "Chưa tìm thấy sticker rõ ràng. Hãy thử giảm độ nhạy nhận diện.",
    boxes.length === 0,
  );
  setBusy(false);
}

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Vui lòng chọn một file ảnh.", true);
    return;
  }

  sourceName = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_") || "sticker";
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    URL.revokeObjectURL(url);
    sourceImage = image;
    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = image.naturalWidth;
    sourceCanvas.height = image.naturalHeight;
    sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    sourceCtx.drawImage(image, 0, 0);
    scanButton.disabled = false;
    await scanImage();
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus("Không đọc được ảnh này.", true);
  };
  image.src = url;
}

async function downloadAll() {
  if (!currentStickers.length) return;

  if (!window.JSZip) {
    setStatus("Không tải được thư viện nén zip. Bạn vẫn có thể tải từng PNG.", true);
    return;
  }

  const zip = new JSZip();
  for (const sticker of currentStickers) {
    zip.file(sticker.filename, sticker.blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sourceName}_stickers.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
scanButton.addEventListener("click", scanImage);
downloadAllButton.addEventListener("click", downloadAll);

[paddingInput, sensitivityInput].forEach((input) => {
  input.addEventListener("input", updateLabels);
  input.addEventListener("change", scanImage);
});
transparentInput.addEventListener("change", scanImage);

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  loadFile(event.dataTransfer.files[0]);
});

updateLabels();
