/// <reference types="vite-plugin-pwa/client" />

import '@fontsource/noto-sans/index.css';
import '@fontsource/noto-sans/500.css';
import '@fontsource/noto-sans/600.css';
import '@fontsource/noto-sans-jp/index.css';
import '@fontsource/noto-sans-jp/500.css';
import '@fontsource/noto-sans-jp/600.css';
import 'material-icons/iconfont/round.css';

import Alpine from 'alpinejs';
import { registerSW } from 'virtual:pwa-register';
import { db, processImage } from './db';
import type { Circle, Item, EventFolder } from './db';
import { translations, languageList, type Language } from './i18n';

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

registerSW({ immediate: true });

const drawWrappedText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  align: 'left' | 'right' | 'center' = 'left'
): number => {
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  const words = Array.from(text);
  let line = '';
  let lineCount = 0;
  let currentY = y;

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n];
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;
    if (testWidth > maxWidth && n > 0) {
      ctx.fillText(line, x, currentY);
      line = words[n];
      currentY += lineHeight;
      lineCount++;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, currentY);
  lineCount++;
  return lineCount * lineHeight;
};

const getWrappedTextHeight = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  lineHeight: number
): number => {
  const words = Array.from(text);
  let line = '';
  let lineCount = 0;

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n];
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;
    if (testWidth > maxWidth && n > 0) {
      line = words[n];
      lineCount++;
    } else {
      line = testLine;
    }
  }
  lineCount++;
  return lineCount * lineHeight;
};

const measureItemTextWithIndent = (
  ctx: CanvasRenderingContext2D,
  text: string,
  fullMaxWidth: number,
  reservedWidth: number,
  indentWidth: number,
  scale: number
): { lines: string[], needsExtraLine: boolean } => {
  const words = Array.from(text);
  let line = '';
  const lines: string[] = [];
  const maxW = fullMaxWidth - indentWidth;
  
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n];
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxW && n > 0) {
      lines.push(line);
      line = words[n];
    } else {
      line = testLine;
    }
  }
  if (line) lines.push(line);
  if (lines.length === 0) lines.push('');
  
  const lastLineWidth = ctx.measureText(lines[lines.length - 1]).width;
  const textRight = indentWidth + lastLineWidth;
  const availableRight = fullMaxWidth - reservedWidth - 10 * scale;
  
  const needsExtraLine = textRight > availableRight;
  
  return { lines, needsExtraLine };
};

const themeColorMap: Record<string, { light: string; dark: string }> = {
  blue: { light: '#020166', dark: '#1a237e' },
  sky: { light: '#0288d1', dark: '#01579b' },
  mint: { light: '#00897b', dark: '#004d40' },
  sage: { light: '#43a047', dark: '#1b5e20' },
  amber: { light: '#f57c00', dark: '#b26a00' },
  coral: { light: '#f4511e', dark: '#bf360c' },
  rose: { light: '#d81b60', dark: '#880e4f' },
  lilac: { light: '#8e24aa', dark: '#4a148c' },
  mono: { light: '#212121', dark: '#121212' }
};

let pdfDocCache: any = null;
let patchRenderTimeout: number | undefined = undefined;
let currentRenderTasks: any[] = [];

Alpine.data('app', () => {
  let savedTheme = localStorage.getItem('themeColor') || 'blue';
  const themeMigrationMap: Record<string, string> = {
    'pink': 'rose',
    'green': 'sage',
    'orange': 'amber',
    'clay': 'amber',
    'peach': 'coral'
  };
  if (themeMigrationMap[savedTheme]) {
    savedTheme = themeMigrationMap[savedTheme];
    localStorage.setItem('themeColor', savedTheme);
  }

  return {
    lang: (localStorage.getItem('lang') || 'ja') as Language,
    languageList,
    appearance: localStorage.getItem('appearance') || 'system',
    themeColor: savedTheme,
    systemIsDark: window.matchMedia('(prefers-color-scheme: dark)').matches,

    get isDark() {
      if (this.appearance === 'system') return this.systemIsDark;
      return this.appearance === 'dark';
    },

    setAppearance(val: string) {
      this.appearance = val;
      localStorage.setItem('appearance', val);
      this.updateMetaThemeColor();
    },

    setThemeColor(val: string) {
      this.themeColor = val;
      localStorage.setItem('themeColor', val);
      this.updateMetaThemeColor();
    },

    updateMetaThemeColor() {
      const colorObj = themeColorMap[this.themeColor] || themeColorMap.blue;
      const colorCode = this.isDark ? colorObj.dark : colorObj.light;
      const metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) {
        metaTheme.setAttribute('content', colorCode);
      }
    },

    t(key: keyof typeof translations['ja']) { 
      return (translations as any)[this.lang]?.[key] || translations['ja'][key] || key; 
    },
    
    setLang(l: string) { this.lang = l as Language; localStorage.setItem('lang', l); },

    events: [] as EventFolder[],
    currentEvent: null as EventFolder | null,
    circles: [] as Circle[],
    selectedUuids: [] as string[],
    isMenuOpen: false, 
    isFormOpen: false, 
    isSettingsOpen: false,
    isDeleteMode: false,
    isSummaryOpen: false,
    pdfUrl: null as string | null,
    editingUuid: null as string | null,
    
    activeContextId: null as number | null,

    isCircleDetailOpen: false,
    selectedCircle: null as Circle | null,

    eventSortDesc: true,
    
    pdfWidth: parseInt(localStorage.getItem('pdfWidth') || '40'),
    pdfHeight: parseInt(localStorage.getItem('pdfHeight') || '250'),
    isPdfCollapsed: false,

    isAboutOpen: false,
    aboutTab: 'usage',

    pdfZoom: 1.0,
    initialPinchDist: 0,
    initialPinchZoom: 1.0,
    pinchCenterX: 0,
    pinchCenterY: 0,

    imgZoom: 1.0,
    initialImgPinchDist: 0,
    initialImgZoom: 1.0,
    imgPinchCenterX: 0,
    imgPinchCenterY: 0,

    confirmModal: {
      isOpen: false,
      message: '',
      onConfirm: null as (() => Promise<void> | void) | null
    },

    importModal: {
      isOpen: false,
      file: null as File | null,
      fileName: '',
      mode: 'new' as 'new' | 'append'
    },

    exportModal: {
      isOpen: false,
      type: 'json' as 'json' | 'image',
      fileName: '',
    },

    showConfirm(message: string, callback: () => Promise<void> | void) {
      this.confirmModal.message = message;
      this.confirmModal.onConfirm = callback;
      this.confirmModal.isOpen = true;
    },
    
    closeConfirm() {
      this.confirmModal.isOpen = false;
      this.confirmModal.onConfirm = null;
    },

    openExportModal(type: 'json' | 'image') {
      this.exportModal.type = type;
      const baseName = this.currentEvent?.name || 'MyLoot';
      this.exportModal.fileName = type === 'json' ? baseName : `${baseName}_Purchased`;
      this.exportModal.isOpen = true;
    },

    executeExport() {
      const fileName = this.exportModal.fileName || 'export';
      if (this.exportModal.type === 'json') {
        this.exportData(fileName + '.json');
      } else {
        this.generateReceiptImage(fileName + '.png');
      }
      this.exportModal.isOpen = false;
    },

    closeForm() {
      this.isFormOpen = false;
      setTimeout(() => {
        this.editingUuid = null;
      }, 200);
    },

    async moveCircleUp(index: number) {
      if (index <= 0) return;
      const newCircles = [...this.circles];
      [newCircles[index - 1], newCircles[index]] = [newCircles[index], newCircles[index - 1]];
      this.circles = newCircles;
      if (this.currentEvent && this.currentEvent.id !== undefined) {
        const newOrderUuids = this.circles.map(c => c.uuid);
        await db.eventOrders.put({ eventId: this.currentEvent.id, circleUuids: newOrderUuids });
      }
    },

    async moveCircleDown(index: number) {
      if (index >= this.circles.length - 1) return;
      const newCircles = [...this.circles];
      [newCircles[index + 1], newCircles[index]] = [newCircles[index], newCircles[index + 1]];
      this.circles = newCircles;
      if (this.currentEvent && this.currentEvent.id !== undefined) {
        const newOrderUuids = this.circles.map(c => c.uuid);
        await db.eventOrders.put({ eventId: this.currentEvent.id, circleUuids: newOrderUuids });
      }
    },

    openCircleDetail(circle: Circle) {
      if (this.isDeleteMode) return;
      this.selectedCircle = circle;
      this.isCircleDetailOpen = true;
    },

    hidePatches() {
      document.querySelectorAll('.pdf-patch-canvas').forEach(el => {
        const patch = el as HTMLElement;
        patch.style.transition = 'none';
        patch.style.opacity = '0';
        patch.setAttribute('data-active', 'false');
      });
    },

    triggerPatchRender() {
      if (patchRenderTimeout) window.clearTimeout(patchRenderTimeout);
      patchRenderTimeout = window.setTimeout(() => {
        this.executePatchRender();
      }, 300);
    },

    async executePatchRender() {
      if (!pdfDocCache) return;
      const wrapper = document.getElementById('pdf-scroll-wrapper');
      if (!wrapper) return;

      currentRenderTasks.forEach(task => {
        try { task.cancel(); } catch(e){}
      });
      currentRenderTasks = [];

      const wrapRect = wrapper.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 2;
      const pageWrappers = document.querySelectorAll('.pdf-page-wrapper');
      
      for (let i = 0; i < pageWrappers.length; i++) {
        const pWrap = pageWrappers[i] as HTMLElement;
        const patches = pWrap.querySelectorAll('.pdf-patch-canvas') as NodeListOf<HTMLCanvasElement>;
        
        const pRect = pWrap.getBoundingClientRect();
        
        if (pRect.bottom < wrapRect.top || pRect.top > wrapRect.bottom || pRect.right < wrapRect.left || pRect.left > wrapRect.right) {
          continue; 
        }
        
        const visibleLeft = Math.max(0, wrapRect.left - pRect.left);
        const visibleTop = Math.max(0, wrapRect.top - pRect.top);
        const visibleRight = Math.min(pRect.width, wrapRect.right - pRect.left);
        const visibleBottom = Math.min(pRect.height, wrapRect.bottom - pRect.top);
        
        const patchW = visibleRight - visibleLeft;
        const patchH = visibleBottom - visibleTop;
        
        if (patchW <= 0 || patchH <= 0) continue;

        let activePatch: HTMLCanvasElement | null = null;
        let nextPatch: HTMLCanvasElement;

        if (patches[0].getAttribute('data-active') === 'true') {
          activePatch = patches[0];
          nextPatch = patches[1];
        } else if (patches[1].getAttribute('data-active') === 'true') {
          activePatch = patches[1];
          nextPatch = patches[0];
        } else {
          nextPatch = patches[0];
        }

        nextPatch.style.transition = 'none';
        nextPatch.style.opacity = '0';
        nextPatch.style.left = visibleLeft + 'px';
        nextPatch.style.top = visibleTop + 'px';
        nextPatch.style.width = patchW + 'px';
        nextPatch.style.height = patchH + 'px';
        
        nextPatch.width = Math.floor(patchW * pixelRatio);
        nextPatch.height = Math.floor(patchH * pixelRatio);

        const ctx = nextPatch.getContext('2d');
        if (!ctx) continue;
        
        const page = await pdfDocCache.getPage(i + 1);
        const baseViewport = page.getViewport({ scale: 1.0 });
        const dynamicScale = pRect.width / baseViewport.width;
        const viewport = page.getViewport({ scale: dynamicScale });

        const transform = [
          pixelRatio, 0, 
          0, pixelRatio, 
          -visibleLeft * pixelRatio, -visibleTop * pixelRatio
        ];

        const renderTask = page.render({
          canvasContext: ctx,
          viewport: viewport,
          transform: transform
        });
        
        currentRenderTasks.push(renderTask);
        try { 
          await renderTask.promise; 
          
          nextPatch.style.transition = 'opacity 0.25s ease-in-out';
          void nextPatch.offsetWidth;
          nextPatch.style.opacity = '1';
          nextPatch.setAttribute('data-active', 'true');
          
          if (activePatch) {
            activePatch.style.transition = 'opacity 0.25s ease-in-out';
            activePatch.style.opacity = '0';
            activePatch.setAttribute('data-active', 'false');
          }
        } catch(e) { }
      }
    },

    async renderPdf(url: string) {
      try {
        if (pdfDocCache) {
          try { pdfDocCache.destroy(); } catch(e){}
        }

        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const loadingTask = pdfjsLib.getDocument({ url, cMapUrl: '/cmaps/', cMapPacked: true });
        
        pdfDocCache = await loadingTask.promise;
        this.pdfZoom = 1.0;
        
        const container = document.getElementById('pdf-canvas-container');
        if (!container) return;
        container.innerHTML = '';
        
        for (let pageNum = 1; pageNum <= pdfDocCache.numPages; pageNum++) {
          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'pdf-page-wrapper';
          pageWrapper.style.position = 'relative';
          pageWrapper.style.marginBottom = '4px';

          const bgCanvas = document.createElement('canvas');
          bgCanvas.className = 'pdf-bg-canvas';
          bgCanvas.style.width = '100%';
          bgCanvas.style.height = 'auto';
          bgCanvas.style.display = 'block';
          
          const patchCanvas1 = document.createElement('canvas');
          patchCanvas1.className = 'pdf-patch-canvas';
          patchCanvas1.style.position = 'absolute';
          patchCanvas1.style.opacity = '0';
          patchCanvas1.style.pointerEvents = 'none';
          patchCanvas1.setAttribute('data-active', 'false');

          const patchCanvas2 = document.createElement('canvas');
          patchCanvas2.className = 'pdf-patch-canvas';
          patchCanvas2.style.position = 'absolute';
          patchCanvas2.style.opacity = '0';
          patchCanvas2.style.pointerEvents = 'none';
          patchCanvas2.setAttribute('data-active', 'false');

          pageWrapper.appendChild(bgCanvas);
          pageWrapper.appendChild(patchCanvas1);
          pageWrapper.appendChild(patchCanvas2);
          container.appendChild(pageWrapper);

          const page = await pdfDocCache.getPage(pageNum);
          const viewport = page.getViewport({ scale: 2.0 });
          bgCanvas.width = viewport.width;
          bgCanvas.height = viewport.height;
          const ctx = bgCanvas.getContext('2d');
          if (ctx) await page.render({ canvasContext: ctx, viewport }).promise;
        }

        const wrapper = document.getElementById('pdf-scroll-wrapper');
        if (wrapper && !wrapper.hasAttribute('data-scroll-bound')) {
          wrapper.setAttribute('data-scroll-bound', 'true');
          wrapper.addEventListener('scroll', () => {
            this.triggerPatchRender();
          });
        }
        
        this.triggerPatchRender();
      } catch (e) {
        console.error(e);
      }
    },

    handleTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        this.hidePatches();
        this.initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this.initialPinchZoom = this.pdfZoom;

        const wrapper = document.getElementById('pdf-scroll-wrapper');
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          const clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          
          this.pinchCenterX = wrapper.scrollLeft + (clientX - rect.left);
          this.pinchCenterY = wrapper.scrollTop + (clientY - rect.top);
        }
      }
    },
    
    handleTouchMove(e: TouchEvent) {
      if (e.touches.length === 2) {
        e.preventDefault();
        const wrapper = document.getElementById('pdf-scroll-wrapper');
        if (!wrapper) return;

        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const scaleRatio = currentDist / this.initialPinchDist;
        const newZoom = Math.max(1.0, Math.min(this.initialPinchZoom * scaleRatio, 10.0));

        if (newZoom !== this.pdfZoom) {
          const zoomDelta = newZoom / this.pdfZoom;
          this.pdfZoom = newZoom;

          const newPinchCenterX = this.pinchCenterX * zoomDelta;
          const newPinchCenterY = this.pinchCenterY * zoomDelta;

          const rect = wrapper.getBoundingClientRect();
          const clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          
          wrapper.scrollLeft = newPinchCenterX - (clientX - rect.left);
          wrapper.scrollTop = newPinchCenterY - (clientY - rect.top);

          this.pinchCenterX = newPinchCenterX;
          this.pinchCenterY = newPinchCenterY;
          
          this.hidePatches();
          this.triggerPatchRender();
        }
      }
    },

    togglePdfZoom(e: any) {
      const wrapper = document.getElementById('pdf-scroll-wrapper');
      if (!wrapper) return;

      const rect = wrapper.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0].clientX) || (rect.left + rect.width / 2);
      const clientY = e.clientY || (e.touches && e.touches[0].clientY) || (rect.top + rect.height / 2);

      const xRect = clientX - rect.left;
      const yRect = clientY - rect.top;

      const xContent = wrapper.scrollLeft + xRect;
      const yContent = wrapper.scrollTop + yRect;

      let targetZoom = 1.0;
      if (this.pdfZoom < 2.5) {
        targetZoom = 3.0;
      } else if (this.pdfZoom < 4.5) {
        targetZoom = 5.0;
      } else {
        targetZoom = 1.0;
      }

      const scale = targetZoom / this.pdfZoom;
      this.pdfZoom = targetZoom;
      
      this.hidePatches();

      setTimeout(() => {
        wrapper.scrollLeft = (xContent * scale) - xRect;
        wrapper.scrollTop = (yContent * scale) - yRect;
        this.triggerPatchRender();
      }, 50);
    },

    handleImgTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        this.initialImgPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        this.initialImgZoom = this.imgZoom;

        const wrapper = document.getElementById('img-scroll-wrapper');
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          const clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          
          this.imgPinchCenterX = wrapper.scrollLeft + (clientX - rect.left);
          this.imgPinchCenterY = wrapper.scrollTop + (clientY - rect.top);
        }
      }
    },
    
    handleImgTouchMove(e: TouchEvent) {
      if (e.touches.length === 2) {
        e.preventDefault();
        const wrapper = document.getElementById('img-scroll-wrapper');
        if (!wrapper) return;

        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const scaleRatio = currentDist / this.initialImgPinchDist;
        const newZoom = Math.max(1.0, Math.min(this.initialImgZoom * scaleRatio, 10.0));

        if (newZoom !== this.imgZoom) {
          const zoomDelta = newZoom / this.imgZoom;
          this.imgZoom = newZoom;

          const newPinchCenterX = this.imgPinchCenterX * zoomDelta;
          const newPinchCenterY = this.imgPinchCenterY * zoomDelta;

          const rect = wrapper.getBoundingClientRect();
          const clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          
          wrapper.scrollLeft = newPinchCenterX - (clientX - rect.left);
          wrapper.scrollTop = newPinchCenterY - (clientY - rect.top);

          this.imgPinchCenterX = newPinchCenterX;
          this.imgPinchCenterY = newPinchCenterY;
        }
      }
    },

    toggleImgZoom(e: any) {
      const wrapper = document.getElementById('img-scroll-wrapper');
      if (!wrapper) return;

      const rect = wrapper.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0].clientX) || (rect.left + rect.width / 2);
      const clientY = e.clientY || (e.touches && e.touches[0].clientY) || (rect.top + rect.height / 2);

      const xRect = clientX - rect.left;
      const yRect = clientY - rect.top;

      const xContent = wrapper.scrollLeft + xRect;
      const yContent = wrapper.scrollTop + yRect;

      const targetZoom = this.imgZoom > 1.0 ? 1.0 : 2.5;
      const scale = targetZoom / this.imgZoom;

      this.imgZoom = targetZoom;

      setTimeout(() => {
        wrapper.scrollLeft = (xContent * scale) - xRect;
        wrapper.scrollTop = (yContent * scale) - yRect;
      }, 50);
    },

    get mapPaneStyle() {
      if (window.innerWidth >= 900) {
        const w = this.isPdfCollapsed ? '1px' : `${this.pdfWidth}vw`;
        return { width: w };
      } else {
        const h = this.isPdfCollapsed ? '1px' : `${this.pdfHeight}px`;
        return { height: h };
      }
    },

    isEventModalOpen: false,
    editingEventId: null as number | null,
    tempEventName: '',
    tempEventDate: '',

    columns: parseInt(localStorage.getItem('columns') || '1') as 1 | 2,

    isToolbarOpen: localStorage.getItem('isToolbarOpen') !== 'false',
    toggleToolbar() {
      this.isToolbarOpen = !this.isToolbarOpen;
      localStorage.setItem('isToolbarOpen', this.isToolbarOpen.toString());
    },

    previewImages: [] as string[],
    previewIndex: 0,
    imgStyles: { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' },

    get zoomedImgStyles() {
      const zoom = this.imgZoom;
      const styles = this.imgStyles as { width: string; height: string };
      
      if (styles.width === '100%') {
        return { width: `${zoom * 100}%`, height: 'auto', maxWidth: 'none', maxHeight: 'none', display: 'block' };
      } else {
        return { height: `${zoom * 100}%`, width: 'auto', maxWidth: 'none', maxHeight: 'none', display: 'block' };
      }
    },

    newName: '',
    newSpace: '',
    newLinks: [{ url: '' }],
    newItems: [] as Item[],
    newImagesPreview: [] as string[],
    newFile: null as File | null,

    async loadEvents() {
      let list = await db.events.toArray();
      list.sort((a, b) => {
        const dateA = new Date(a.date || 0).getTime();
        const dateB = new Date(b.date || 0).getTime();
        return this.eventSortDesc ? dateB - dateA : dateA - dateB;
      });
      this.events = list;
    },

    toggleEventSort() {
      this.eventSortDesc = !this.eventSortDesc;
      this.loadEvents();
    },

    async init() {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        this.systemIsDark = e.matches;
        this.updateMetaThemeColor();
      });

      this.updateMetaThemeColor();
      this.initResizer();
      await this.loadEvents();
      
      const lastEventId = localStorage.getItem('lastEventId');
      let targetEvent = null;
      
      if (lastEventId) {
        targetEvent = this.events.find(e => e.id === parseInt(lastEventId));
      }
      
      if (!targetEvent && this.events.length > 0) {
        targetEvent = this.events[0];
      }

      if (targetEvent) {
        await this.selectEvent(targetEvent);
      } else if (this.events.length === 0) {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        
        const eventId = await db.events.add({ 
          name: this.lang === 'ja' ? 'サンプルイベント' : 'Sample Event', 
          date: `${yyyy}-${mm}-${dd}` 
        });

        if (eventId) {
          const uuid1 = crypto.randomUUID();
          const uuid2 = crypto.randomUUID();
          const uuid3 = crypto.randomUUID();

          await db.circles.bulkAdd([
            {
              uuid: uuid1,
              eventId: eventId,
              name: this.lang === 'ja' ? 'サークルまいるーと' : 'Circle Mai-ruuto',
              space: '東A01a',
              links: ['https://www.pixiv.net/'],
              isChecked: false,
              items: [
                { name: this.lang === 'ja' ? '新刊セット' : 'New Book Set', price: 1000, quantity: 1, isChecked: false },
                { name: this.lang === 'ja' ? 'アクスタ' : 'Acrylic Stand', price: 500, quantity: 2, isChecked: true }
              ]
            },
            {
              uuid: uuid2,
              eventId: eventId,
              name: this.lang === 'ja' ? 'TESTサークル' : 'Test Circle',
              space: '西あ12b',
              links: [],
              isChecked: false,
              items: [
                { name: this.lang === 'ja' ? '既刊' : 'Previous Book', price: 500, quantity: 1, isChecked: false }
              ]
            },
            {
              uuid: uuid3,
              eventId: eventId,
              name: this.lang === 'ja' ? '我道工房' : 'Waremichi Koubou',
              space: '南A34c',
              links: [],
              isChecked: false,
              items: [
                { name: this.lang === 'ja' ? '無配' : 'Free Book', price: 0, quantity: 1, isChecked: false }
              ]
            }
          ]);
          await db.eventOrders.put({ eventId: eventId, circleUuids: [uuid1, uuid2, uuid3] });
        }

        await this.loadEvents();
        const first = await db.events.get(eventId);
        if (first) await this.selectEvent(first);
      }
    },

    initResizer() {
      const resizer = document.getElementById('resizer');
      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let startSize = 0;

      const start = (e: any) => { 
        isDragging = true; 
        this.isPdfCollapsed = false;
        this.hidePatches();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;
        
        if (window.innerWidth >= 900) {
          startSize = (this.pdfWidth * window.innerWidth) / 100;
        } else {
          startSize = this.pdfHeight;
        }
        document.body.style.userSelect = 'none';
      };

      const end = () => { 
        if (!isDragging) return;
        isDragging = false; 
        document.body.style.userSelect = 'auto';
        this.triggerPatchRender();
        
        if (window.innerWidth >= 900) {
          if (this.pdfWidth < 3) this.isPdfCollapsed = true;
          localStorage.setItem('pdfWidth', this.pdfWidth.toString());
        } else {
          if (this.pdfHeight < 30) this.isPdfCollapsed = true;
          localStorage.setItem('pdfHeight', this.pdfHeight.toString());
        }
      };
      
      const move = (e: any) => {
        if (!isDragging) return;
        this.hidePatches();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        if (window.innerWidth >= 900) {
          const deltaX = startX - clientX;
          const newSizePx = startSize + deltaX;
          const vw = (newSizePx / window.innerWidth) * 100;
          this.pdfWidth = Math.max(0, Math.min(95, vw));
        } else {
          const deltaY = startY - clientY;
          const newSizePx = startSize + deltaY;
          this.pdfHeight = Math.max(0, Math.min(window.innerHeight - 80, newSizePx));
        }
      };

      resizer?.addEventListener('mousedown', start);
      resizer?.addEventListener('touchstart', start, { passive: true });
      window.addEventListener('mousemove', move);
      window.addEventListener('touchmove', move, { passive: true });
      window.addEventListener('mouseup', end);
      window.addEventListener('touchend', end);
    },

    toggleColumns() {
      this.columns = this.columns === 1 ? 2 : 1;
      localStorage.setItem('columns', this.columns.toString());
    },

    async selectEvent(event: EventFolder) {
      this.currentEvent = event;
      if (event.id) localStorage.setItem('lastEventId', event.id.toString());
      this.activeContextId = null;
      this.isDeleteMode = false;
      this.selectedUuids = [];
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      
      this.pdfUrl = event.mapPdf ? URL.createObjectURL(event.mapPdf) : null;
      if (this.pdfUrl) {
        this.renderPdf(this.pdfUrl);
      }

      await this.refreshCircles();
      this.isMenuOpen = false; 
      this.isFormOpen = false;
      this.editingUuid = null;
    },

    openEventCreateModal() {
        this.editingEventId = null;
        this.tempEventName = '';
        const today = new Date();
        this.tempEventDate = today.toISOString().split('T')[0];
        this.isEventModalOpen = true;
    },
    openEventEditModal(event: EventFolder) {
        this.activeContextId = null;
        this.editingEventId = event.id!;
        this.tempEventName = event.name;
        this.tempEventDate = event.date || '';
        this.isEventModalOpen = true;
    },
    async saveEvent() {
        if (!this.tempEventName.trim()) return;
        
        if (this.editingEventId) {
            await db.events.update(this.editingEventId, { name: this.tempEventName, date: this.tempEventDate });
            
            if (this.currentEvent && this.currentEvent.id === this.editingEventId) {
                this.currentEvent.name = this.tempEventName;
                this.currentEvent.date = this.tempEventDate;
            }
        } else {
            const id = await db.events.add({ name: this.tempEventName, date: this.tempEventDate });
            const newEv = await db.events.get(id);
            if (newEv) await this.selectEvent(newEv);
        }
        await this.loadEvents();
        this.isEventModalOpen = false;
    },

    async duplicateEvent(event: EventFolder) {
      if (!event.id) return;
      const circles = await db.circles.where('eventId').equals(event.id).toArray();
      const orderRecord = await db.eventOrders.get(event.id);
      
      const newId = await db.events.add({ 
        name: event.name + ' (Copy)', 
        date: event.date, 
        mapPdf: event.mapPdf 
      });

      const newUuidsMap = new Map<string, string>();
      for (const c of circles) {
        const oldUuid = c.uuid;
        c.uuid = crypto.randomUUID();
        c.eventId = newId;
        newUuidsMap.set(oldUuid, c.uuid);
        await db.circles.add(c);
      }

      if (orderRecord) {
        const newOrder = orderRecord.circleUuids.map(u => newUuidsMap.get(u)).filter(Boolean) as string[];
        await db.eventOrders.put({ eventId: newId, circleUuids: newOrder });
      }

      await this.loadEvents();
      this.activeContextId = null;
    },

    async deleteEvent(id: number) {
      this.showConfirm(this.t('deleteEventConfirm'), async () => {
        await db.events.delete(id);
        await db.circles.where('eventId').equals(id).delete();
        await db.eventOrders.delete(id);
        await this.init();
        this.activeContextId = null;
        this.closeConfirm();
      });
    },

    async refreshCircles() {
      if (this.currentEvent && this.currentEvent.id !== undefined) {
        let list = await db.circles.where('eventId').equals(this.currentEvent.id).toArray();
        const orderRecord = await db.eventOrders.get(this.currentEvent.id);
        
        if (orderRecord && orderRecord.circleUuids.length > 0) {
          const orderMap = new Map();
          orderRecord.circleUuids.forEach((uuid, index) => orderMap.set(uuid, index));
          list.sort((a, b) => {
            const indexA = orderMap.has(a.uuid) ? orderMap.get(a.uuid) : 99999;
            const indexB = orderMap.has(b.uuid) ? orderMap.get(b.uuid) : 99999;
            return indexA - indexB;
          });
        }
        
        this.circles = list;
      }
    },

    openImagePreview(circle: Circle) {
      this.previewImages = circle.images && circle.images.length > 0 
        ? circle.images 
        : (circle.image ? [circle.image] : []);
      this.previewIndex = 0;
      this.imgZoom = 1.0;
      this.imgStyles = { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' };
    },

    nextPreview() {
      this.previewIndex = (this.previewIndex + 1) % this.previewImages.length;
      this.imgZoom = 1.0;
      this.imgStyles = { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' };
    },
    
    prevPreview() {
      this.previewIndex = (this.previewIndex - 1 + this.previewImages.length) % this.previewImages.length;
      this.imgZoom = 1.0;
      this.imgStyles = { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' };
    },

    updateImgStyle(e: Event) {
      const img = e.target as HTMLImageElement;
      if (!img.naturalWidth) return;
      const containerRatio = 635 / 903;
      const imgRatio = img.naturalWidth / img.naturalHeight;
      if (imgRatio > containerRatio) {
        this.imgStyles = { height: '100%', width: 'auto', maxWidth: 'none', maxHeight: 'none' };
      } else {
        this.imgStyles = { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' };
      }
    },

    openAddForm() {
      this.editingUuid = null;
      this.newName = '';
      this.newSpace = '';
      this.newLinks = [{ url: '' }];
      this.newImagesPreview = [];
      this.newFile = null;
      this.newItems = [{ name: '', price: 0, quantity: 1, isChecked: false }];
      this.isFormOpen = true;
      this.isDeleteMode = false;
    },

    async openEditForm(circle: Circle) {
      this.editingUuid = circle.uuid;
      this.newName = circle.name;
      this.newSpace = circle.space;
      this.newFile = null;
      
      this.newImagesPreview = circle.images && circle.images.length > 0 
        ? [...circle.images] 
        : (circle.image ? [circle.image] : []);
      
      const existingLinks = circle.links || (circle.link ? [circle.link] : []);
      this.newLinks = existingLinks.map(u => ({ url: u }));
      if (this.newLinks.length === 0 || this.newLinks[this.newLinks.length - 1].url !== '') {
        this.newLinks.push({ url: '' });
      }

      this.newItems = circle.items.map(i => ({
        name: i.name,
        price: i.price,
        quantity: i.quantity || 1,
        isChecked: i.isChecked
      }));
      if (this.newItems.length === 0 || this.newItems[this.newItems.length - 1].name !== '') {
        this.newItems.push({ name: '', price: 0, quantity: 1, isChecked: false });
      }
      this.isFormOpen = true;
    },

    async handleImageSelect(e: any) {
      const files = e.target.files;
      for (let i = 0; i < files.length; i++) {
        const dataUrl = await processImage(files[i]);
        this.newImagesPreview.push(dataUrl);
      }
      e.target.value = '';
    },

    async saveCircle() {
      if (!this.newName || !this.currentEvent || !this.currentEvent.id) return;
      
      const validLinks = this.newLinks
        .map(l => l.url.trim())
        .filter(u => u !== '')
        .map(u => /^https?:\/\//i.test(u) ? u : `https://${u}`);
        
      const validItems = this.newItems.filter(i => i.name.trim() !== '').map(i => ({
        name: i.name,
        price: Number(i.price) || 0,
        quantity: Number(i.quantity) || 1,
        isChecked: i.isChecked || false
      }));
      
      const data: any = {
        eventId: this.currentEvent.id,
        name: this.newName,
        space: this.newSpace,
        genre: '',
        links: validLinks,
        link: validLinks.length > 0 ? validLinks[0] : '',
        items: validItems,
        isChecked: false,
        images: [...this.newImagesPreview],
        image: this.newImagesPreview.length > 0 ? this.newImagesPreview[0] : ''
      };
      
      if (this.editingUuid) {
        data.uuid = this.editingUuid;
        await db.circles.put(data);
      } else {
        data.uuid = crypto.randomUUID();
        await db.circles.add(data);
        
        const orderRecord = await db.eventOrders.get(this.currentEvent.id);
        const uuids = orderRecord ? orderRecord.circleUuids : [];
        uuids.push(data.uuid);
        await db.eventOrders.put({ eventId: this.currentEvent.id, circleUuids: uuids });
      }
      
      this.closeForm();
      await this.refreshCircles();
    },

    async toggleItemCheck(circleUuid: string, itemIndex: number) {
      if (this.isDeleteMode) return;
      const circle = await db.circles.get(circleUuid);
      if (circle) {
        circle.items[itemIndex].isChecked = !circle.items[itemIndex].isChecked;
        await db.circles.put(circle);
        await this.refreshCircles();

        if (this.selectedCircle && this.selectedCircle.uuid === circleUuid) {
          this.selectedCircle = circle;
        }
      }
    },

    toggleDeleteMode() {
      this.isDeleteMode = !this.isDeleteMode;
      if (!this.isDeleteMode) this.selectedUuids = [];
    },
    selectAll() {
      this.selectedUuids = this.circles.map(c => c.uuid);
    },
    deselectAll() {
      this.selectedUuids = [];
    },
    async deleteSelected() {
      if (this.selectedUuids.length === 0) return;
      this.showConfirm(`${this.selectedUuids.length}${this.t('deleteSelectedConfirm')}`, async () => {
        await db.circles.bulkDelete(this.selectedUuids);
        
        const orderRecord = await db.eventOrders.get(this.currentEvent!.id!);
        if (orderRecord) {
          orderRecord.circleUuids = orderRecord.circleUuids.filter(u => !this.selectedUuids.includes(u));
          await db.eventOrders.put(orderRecord);
        }
        
        this.selectedUuids = [];
        await this.refreshCircles();
        this.closeConfirm();
      });
    },

    checkAutoAddLink(index: number) {
      if (index === this.newLinks.length - 1 && this.newLinks[index].url !== '') {
        this.newLinks.push({ url: '' });
      }
    },
    removeLinkInForm(index: number) {
      this.newLinks.splice(index, 1);
      if (this.newLinks.length === 0) this.newLinks.push({ url: '' });
    },

    async uploadMapPdf(e: any) {
      const file = e.target.files[0];
      if (!file || !this.currentEvent || !this.currentEvent.id) return;
      await db.events.update(this.currentEvent.id, { mapPdf: file });
      this.currentEvent.mapPdf = file;
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      
      this.pdfUrl = URL.createObjectURL(file);
      this.renderPdf(this.pdfUrl);
    },

    async resetMapPdf() {
      if (!this.currentEvent || !this.currentEvent.id) return;
      this.showConfirm(this.t('deletePdfConfirm'), async () => {
        await db.events.update(this.currentEvent!.id!, { mapPdf: undefined });
        this.currentEvent!.mapPdf = undefined;
        if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
        this.pdfUrl = null;
        this.closeConfirm();
      });
    },

    removeItemInForm(index: number) { this.newItems.splice(index, 1); },
    checkAutoAdd(index: number) {
      if (index === this.newItems.length - 1 && this.newItems[index].name !== '') {
        this.newItems.push({ name: '', price: 0, quantity: 1, isChecked: false });
      }
    },
    get totalPrice(): number {
      return this.circles.reduce((sum, c) => sum + c.items.reduce((iSum, item) => iSum + ((Number(item.price) || 0) * (Number(item.quantity) || 1)), 0), 0);
    },

    get purchasedSummary() {
      let total = 0;
      const list = [];
      for (const c of this.circles) {
        const items = c.items.filter(i => i.isChecked);
        if (items.length > 0) {
          const subtotal = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
          total += subtotal;
          list.push({ circleName: c.name, items, subtotal });
        }
      }
      return { list, total };
    },

    get unpurchasedSummary() {
      let total = 0;
      const list = [];
      for (const c of this.circles) {
        const items = c.items.filter(i => !i.isChecked);
        if (items.length > 0) {
          const subtotal = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
          total += subtotal;
          list.push({ circleName: c.name, items, subtotal });
        }
      }
      return { list, total };
    },

    handleImportFileSelect(e: any) {
      const file = e.target.files[0];
      if (file) {
        this.importModal.file = file;
        this.importModal.fileName = file.name;
      } else {
        this.importModal.file = null;
        this.importModal.fileName = '';
      }
    },

    executeImport() {
      if (!this.importModal.file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result as string);
          
          if (this.importModal.mode === 'new') {
            const newId = await db.events.add({ name: data.event.name + ' (Import)', date: data.event.date || new Date().toLocaleDateString() });
            
            const newUuidsMap = new Map<string, string>();
            for (const c of data.circles) {
              const oldUuid = c.uuid || c.id; 
              c.uuid = crypto.randomUUID();
              c.eventId = newId;
              delete c.id;
              newUuidsMap.set(oldUuid, c.uuid);
              await db.circles.add(c); 
            }

            if (data.eventOrders && data.eventOrders.circleUuids) {
              const newOrder = data.eventOrders.circleUuids.map((u: string) => newUuidsMap.get(u)).filter(Boolean) as string[];
              await db.eventOrders.put({ eventId: newId, circleUuids: newOrder });
            } else {
              const newOrder = data.circles.map((c: any) => c.uuid);
              await db.eventOrders.put({ eventId: newId, circleUuids: newOrder });
            }
          } else if (this.importModal.mode === 'append' && this.currentEvent && this.currentEvent.id) {
            const newCircleUuids: string[] = [];
            for (const c of data.circles) {
              c.uuid = crypto.randomUUID();
              c.eventId = this.currentEvent.id;
              delete c.id;
              newCircleUuids.push(c.uuid);
              await db.circles.add(c); 
            }
            
            const orderRecord = await db.eventOrders.get(this.currentEvent.id);
            if (orderRecord) {
              orderRecord.circleUuids.push(...newCircleUuids);
              await db.eventOrders.put(orderRecord);
            } else {
              await db.eventOrders.put({ eventId: this.currentEvent.id, circleUuids: newCircleUuids });
            }
          }

          this.importModal.isOpen = false;
          this.importModal.file = null;
          this.importModal.fileName = '';
          await this.init();
        } catch (e) {
          console.error("Import failed:", e);
          alert("Failed to import data.");
        }
      };
      reader.readAsText(this.importModal.file);
    },

    generateReceiptImage(fileName: string) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const data = this.purchasedSummary;
      if (data.list.length === 0) return;

      const scale = 2; 
      const width = 500 * scale;
      const padding = 40 * scale;
      const paddingTop = 40 * scale;
      const paddingBottom = 45 * scale;
      
      const titleFont = `bold ${32 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
      const subTitleFont = `bold ${22 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
      const circleFont = `bold ${20 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
      const itemFont = `400 ${20 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
      const itemMetaFont = `400 ${13 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
      const totalLabelFont = `bold ${28 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
      const totalValueFont = `bold ${32 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;

      const primaryColor = '#1c1c1e';
      const mutColor = '#8e8e93';

      const renderPass = (isDraw: boolean) => {
        let y = paddingTop;

        ctx.font = titleFont;
        ctx.fillStyle = primaryColor;
        if (isDraw) {
          y += drawWrappedText(ctx, this.currentEvent?.name || 'Event', width / 2, y, width - padding * 2, 40 * scale, 'center');
        } else {
          y += getWrappedTextHeight(ctx, this.currentEvent?.name || 'Event', width - padding * 2, 40 * scale);
        }
        
        ctx.font = subTitleFont;
        if (isDraw) drawWrappedText(ctx, 'PURCHASED LIST', width / 2, y, width - padding * 2, 30 * scale, 'center');
        y += 30 * scale;
        y += 10 * scale;
        
        if (isDraw) {
          ctx.strokeStyle = primaryColor;
          ctx.lineWidth = 2 * scale;
          ctx.beginPath();
          ctx.moveTo(padding, y);
          ctx.lineTo(width - padding, y);
          ctx.stroke();
        }
        y += 30 * scale;

        data.list.forEach(group => {
          ctx.font = circleFont;
          ctx.fillStyle = primaryColor;
          if (isDraw) y += drawWrappedText(ctx, group.circleName, padding, y, width - padding * 2, 28 * scale, 'left');
          else y += getWrappedTextHeight(ctx, group.circleName, width - padding * 2, 28 * scale);
          y += 4 * scale;

          group.items.forEach(item => {
            const priceStr = `¥${((item.price || 0) * (item.quantity || 1)).toLocaleString()}`;
            const metaStr = (item.quantity > 1 || item.price > 0) ? `@${(item.price || 0).toLocaleString()} x ${item.quantity || 1}` : '';
            
            ctx.font = itemFont;
            const actualPriceWidth = ctx.measureText(priceStr).width;
            
            let actualMetaWidth = 0;
            if (metaStr) {
              ctx.font = itemMetaFont;
              actualMetaWidth = ctx.measureText(metaStr).width;
            }
            
            ctx.font = itemFont;
            const indentWidth = ctx.measureText('・').width;
            const fullMaxWidth = width - padding * 2;
            const reservedWidth = actualPriceWidth + (metaStr ? actualMetaWidth + 10 * scale : 0);

            const { lines, needsExtraLine } = measureItemTextWithIndent(ctx, item.name, fullMaxWidth, reservedWidth, indentWidth, scale);
            const lineHeight = 24 * scale;
            
            if (isDraw) {
              const startY = y;
              ctx.fillStyle = primaryColor;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';

              ctx.fillText('・', padding, y);
              lines.forEach((lineText, idx) => {
                 ctx.fillText(lineText, padding + indentWidth, y + idx * lineHeight);
              });
              
              const priceY = startY + (lines.length - 1 + (needsExtraLine ? 1 : 0)) * lineHeight;
              
              ctx.font = itemFont;
              ctx.textAlign = 'right';
              ctx.fillText(priceStr, width - padding, priceY);

              if (metaStr) {
                ctx.fillStyle = mutColor;
                ctx.font = itemMetaFont;
                ctx.fillText(metaStr, width - padding - actualPriceWidth - 10 * scale, priceY + 5.5 * scale);
              }
            }
            
            y += (lines.length + (needsExtraLine ? 1 : 0)) * lineHeight; 
            y += 4 * scale;
          });
          y += 15 * scale;
        });

        y += 10 * scale;
        
        if (isDraw) {
          ctx.strokeStyle = primaryColor;
          ctx.beginPath();
          ctx.moveTo(padding, y);
          ctx.lineTo(width - padding, y);
          ctx.stroke();
        }
        
        y += 20 * scale;

        ctx.fillStyle = primaryColor;
        ctx.font = totalLabelFont;
        if (isDraw) drawWrappedText(ctx, 'TOTAL', padding, y, width / 2 - padding, 28 * scale, 'left');
        
        ctx.font = totalValueFont;
        if (isDraw) drawWrappedText(ctx, `¥${data.total.toLocaleString()}`, width - padding, y, width / 2 - padding, 32 * scale, 'right');
        
        y += 32 * scale;
        y += 15 * scale;
        
        ctx.fillStyle = mutColor;
        ctx.font = `bold ${18 * scale}px "Noto Sans", "Noto Sans JP", sans-serif`;
        if (isDraw) drawWrappedText(ctx, 'https://myloot.rabbit1.cc/', width / 2, y, width, 22 * scale, 'center');

        y += paddingBottom;

        return y;
      };

      const totalHeight = renderPass(false);

      canvas.width = width;
      canvas.height = totalHeight;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, totalHeight);

      renderPass(true);

      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = fileName;
      document.body.appendChild(a); 
      a.click();
      document.body.removeChild(a);
    },

    async exportData(fileName: string) {
      if (!this.currentEvent || !this.currentEvent.id) return;
      const orderRecord = await db.eventOrders.get(this.currentEvent.id);
      const data = {
        event: this.currentEvent,
        circles: this.circles,
        eventOrders: orderRecord
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a'); 
      a.href = URL.createObjectURL(blob); 
      a.download = fileName; 
      a.click();
    }
  };
});

Alpine.start();