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

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

registerSW({ immediate: true });

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    lang: (localStorage.getItem('lang') || 'ja') as Language,
    languageList,
    darkMode: localStorage.getItem('theme') === 'dark' || 
            (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches),
    
    t(key: keyof typeof translations['ja']) { return translations[this.lang][key] || key; },
    setLang(l: string) { this.lang = l as Language; localStorage.setItem('lang', l); },
    toggleDarkMode() { this.darkMode = !this.darkMode; localStorage.setItem('theme', this.darkMode ? 'dark' : 'light'); },

    events: [] as EventFolder[],
    currentEvent: null as EventFolder | null,
    circles: [] as Circle[],
    selectedIds: [] as number[],
    isMenuOpen: false, 
    isFormOpen: false, 
    isDeleteMode: false,
    pdfUrl: null as string | null,
    editingId: null as number | null,
    
    activeContextId: null as number | null,
    longPressTimer: undefined as number | undefined,

    activeCircleContextId: null as number | null,
    circleLongPressTimer: undefined as number | undefined,
    isCircleDetailOpen: false,
    selectedCircle: null as Circle | null,

    sortOrder: 'space' as 'space' | 'name' | 'priority',
    sortAsc: true,
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

    handleCircleLongPressStart(id: number) {
      if (this.isDeleteMode) return;
      this.circleLongPressTimer = window.setTimeout(() => { this.activeCircleContextId = id; }, 600);
    },
    handleCircleLongPressEnd() {
      window.clearTimeout(this.circleLongPressTimer);
    },

    openCircleDetail(circle: Circle) {
      if (this.isDeleteMode || this.activeCircleContextId === circle.id) return;
      this.selectedCircle = circle;
      this.isCircleDetailOpen = true;
    },

    async deleteCircle(id: number) {
      if (!confirm(`${this.t('deleteOneCircleConfirm')}`)) return;
      await db.circles.delete(id);
      this.activeCircleContextId = null;
      await this.refreshCircles();
    },

    handleTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
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
        }
      }
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

    previewImages: [] as string[],
    previewIndex: 0,
    imgStyles: { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' } as any,

    newName: '',
    newSpace: '',
    newLinks: [{ url: '' }],
    newPriority: 0,
    newItems: [] as Item[],
    newImagesPreview: [] as string[],
    newFile: null as File | null,

    async renderPdf(url: string) {
      try {
        const loadingTask = pdfjsLib.getDocument(url);
        const pdfDoc = await loadingTask.promise;
        
        setTimeout(async () => {
          const container = document.getElementById('pdf-canvas-container');
          if (!container) return;
          container.innerHTML = ''; 
          this.pdfZoom = 1.0; 

          for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-page-canvas';
            container.appendChild(canvas);
            
            const ctx = canvas.getContext('2d');
            if (!ctx) continue;

            const viewport = page.getViewport({ scale: 5.0 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            const renderContext = {
              canvasContext: ctx,
              viewport: viewport,
              canvas: canvas
            };

            await page.render(renderContext).promise;
          }
        }, 50);
      } catch (e) {
        console.error(e);
      }
    },

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
          await db.circles.bulkAdd([
            {
              eventId: eventId,
              name: this.lang === 'ja' ? 'サークルまいるーと' : 'Circle Mai-ruuto',
              space: '東A01a',
              links: ['https://www.pixiv.net/'],
              priority: 3,
              isChecked: false,
              items: [
                { name: this.lang === 'ja' ? '新刊セット' : 'New Book Set', price: 1000, isChecked: false },
                { name: this.lang === 'ja' ? 'アクスタ' : 'Acrylic Stand', price: 500, isChecked: true }
              ]
            },
            {
              eventId: eventId,
              name: this.lang === 'ja' ? 'TESTサークル' : 'Test Circle',
              space: '西あ12b',
              links: [],
              isChecked: false,
              items: [
                { name: this.lang === 'ja' ? '既刊' : 'Previous Book', price: 500, isChecked: false }
              ]
            },
            {
              eventId: eventId,
              name: this.lang === 'ja' ? '我道工房' : 'Waremichi Koubou',
              space: '南A34c',
              links: [],
              priority: 1,
              isChecked: false,
              items: [
                { name: this.lang === 'ja' ? '無配' : 'Free Book', price: 0, isChecked: false }
              ]
            }
          ]);
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

    handleLongPressStart(id: number) {
      this.longPressTimer = window.setTimeout(() => { this.activeContextId = id; }, 600);
    },
    handleLongPressEnd() {
      window.clearTimeout(this.longPressTimer);
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
      this.selectedIds = [];
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      
      this.pdfUrl = event.mapPdf ? URL.createObjectURL(event.mapPdf) : null;
      if (this.pdfUrl) {
        this.renderPdf(this.pdfUrl);
      }

      await this.refreshCircles();
      this.isMenuOpen = false; 
      this.isFormOpen = false;
      this.editingId = null;
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
      const newId = await db.events.add({ 
        name: event.name + ' (Copy)', 
        date: event.date, 
        mapPdf: event.mapPdf 
      });
      for (const c of circles) {
        delete c.id;
        c.eventId = newId;
        await db.circles.add(c);
      }
      await this.loadEvents();
      this.activeContextId = null;
    },

    async deleteEvent(id: number) {
      if (!confirm(this.t('deleteEventConfirm'))) return;
      await db.events.delete(id);
      await db.circles.where('eventId').equals(id).delete();
      await this.init();
      this.activeContextId = null;
    },

    setSortOrder(order: 'space' | 'name' | 'priority') {
      if (this.sortOrder === order) {
        this.sortAsc = !this.sortAsc;
      } else {
        this.sortOrder = order;
        this.sortAsc = order === 'priority' ? false : true;
      }
      this.refreshCircles();
    },

    async refreshCircles() {
      if (this.currentEvent && this.currentEvent.id !== undefined) {
        let list = await db.circles.where('eventId').equals(this.currentEvent.id).toArray();
        
        const getSpaceRank = (space: string) => {
          if (!space) return 99;
          const char = space.charAt(0);
          if (char === '東') return 1;
          if (char === '西') return 2;
          if (char === '南') return 3;
          if (char === '北') return 4;
          if (char === '企') return 5;
          if (/[A-Za-z]/.test(char)) return 6;
          if (/[あ-んア-ン]/.test(char)) return 7;
          if (/[0-9]/.test(char)) return 8;
          return 10;
        };

        list.sort((a, b) => {
          let cmp = 0;
          if (this.sortOrder === 'space') {
            const rankA = getSpaceRank(a.space);
            const rankB = getSpaceRank(b.space);
            if (rankA !== rankB) {
              cmp = rankA - rankB;
            } else {
              cmp = (a.space || '').localeCompare(b.space || '', 'ja', { numeric: true });
            }
          } else if (this.sortOrder === 'priority') {
            const pA = a.priority || 0;
            const pB = b.priority || 0;
            cmp = pA - pB;
          } else {
            cmp = (a.name || '').localeCompare(b.name || '', 'ja');
          }
          return this.sortAsc ? cmp : -cmp;
        });
        
        this.circles = list;
      }
    },

    openImagePreview(circle: Circle) {
      this.previewImages = circle.images && circle.images.length > 0 
        ? circle.images 
        : (circle.image ? [circle.image] : []);
      this.previewIndex = 0;
      this.imgStyles = { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' };
    },

    nextPreview() {
      this.previewIndex = (this.previewIndex + 1) % this.previewImages.length;
      this.imgStyles = { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' };
    },
    
    prevPreview() {
      this.previewIndex = (this.previewIndex - 1 + this.previewImages.length) % this.previewImages.length;
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
      this.editingId = null;
      this.newName = '';
      this.newSpace = '';
      this.newLinks = [{ url: '' }];
      this.newPriority = 0;
      this.newImagesPreview = [];
      this.newFile = null;
      this.newItems = [{ name: '', price: 0, isChecked: false }];
      this.isFormOpen = true;
      this.isDeleteMode = false;
    },

    async openEditForm(circle: Circle) {
      if (this.isDeleteMode) return;
      this.editingId = circle.id!;
      this.newName = circle.name;
      this.newSpace = circle.space;
      this.newPriority = circle.priority || 0;
      this.newFile = null;
      
      this.newImagesPreview = circle.images && circle.images.length > 0 
        ? [...circle.images] 
        : (circle.image ? [circle.image] : []);
      
      const existingLinks = circle.links || (circle.link ? [circle.link] : []);
      this.newLinks = existingLinks.map(u => ({ url: u }));
      if (this.newLinks.length === 0 || this.newLinks[this.newLinks.length - 1].url !== '') {
        this.newLinks.push({ url: '' });
      }

      this.newItems = JSON.parse(JSON.stringify(circle.items));
      if (this.newItems.length === 0 || this.newItems[this.newItems.length - 1].name !== '') {
        this.newItems.push({ name: '', price: 0, isChecked: false });
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
        isChecked: i.isChecked || false
      }));
      
      const data: any = {
        eventId: this.currentEvent.id,
        name: this.newName,
        space: this.newSpace,
        genre: '',
        links: validLinks,
        link: validLinks.length > 0 ? validLinks[0] : '',
        priority: Number(this.newPriority),
        items: validItems,
        isChecked: false,
        images: [...this.newImagesPreview],
        image: this.newImagesPreview.length > 0 ? this.newImagesPreview[0] : ''
      };
      
      if (this.editingId) {
        await db.circles.update(this.editingId, data);
      } else {
        await db.circles.add(data);
      }
      
      this.isFormOpen = false;
      this.editingId = null;
      await this.refreshCircles();
    },

    async toggleItemCheck(circleId: number, itemIndex: number) {
      if (this.isDeleteMode) return;
      const circle = await db.circles.get(circleId);
      if (circle) {
        circle.items[itemIndex].isChecked = !circle.items[itemIndex].isChecked;
        await db.circles.put(circle);
        await this.refreshCircles();

        if (this.selectedCircle && this.selectedCircle.id === circleId) {
          this.selectedCircle = circle;
        }
      }
    },

    toggleDeleteMode() {
      this.isDeleteMode = !this.isDeleteMode;
      if (!this.isDeleteMode) this.selectedIds = [];
    },
    selectAll() {
      this.selectedIds = this.circles.map(c => c.id!);
    },
    deselectAll() {
      this.selectedIds = [];
    },
    async deleteSelected() {
      if (this.selectedIds.length === 0) return;
      if (!confirm(`${this.selectedIds.length}${this.t('deleteSelectedConfirm')}`)) return;
      await db.circles.bulkDelete(this.selectedIds.map(Number));
      this.selectedIds = [];
      this.isDeleteMode = false;
      await this.refreshCircles();
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
      if (!this.currentEvent || !this.currentEvent.id || !confirm(this.t('deletePdfConfirm'))) return;
      await db.events.update(this.currentEvent.id, { mapPdf: undefined });
      this.currentEvent.mapPdf = undefined;
      if (this.pdfUrl) URL.revokeObjectURL(this.pdfUrl);
      this.pdfUrl = null;
    },

    removeItemInForm(index: number) { this.newItems.splice(index, 1); },
    checkAutoAdd(index: number) {
      if (index === this.newItems.length - 1 && this.newItems[index].name !== '') {
        this.newItems.push({ name: '', price: 0, isChecked: false });
      }
    },
    get totalPrice(): number {
      return this.circles.reduce((sum, c) => sum + c.items.reduce((iSum, item) => iSum + (Number(item.price) || 0), 0), 0);
    },
    async exportData() {
      if (!this.currentEvent) return;
      const blob = new Blob([JSON.stringify({ event: this.currentEvent, circles: this.circles })], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${this.currentEvent.name}.json`; a.click();
    },
    async importData(e: any) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const data = JSON.parse(reader.result as string);
        const newId = await db.events.add({ name: data.event.name + ' (Import)', date: data.event.date || new Date().toLocaleDateString() });
        for (const c of data.circles) { delete c.id; c.eventId = newId; await db.circles.add(c); }
        await this.init();
      };
      reader.readAsText(file);
    },
  }));
});
Alpine.start();