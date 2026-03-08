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
    selectedUuids: [] as string[],
    isMenuOpen: false, 
    isFormOpen: false, 
    isDeleteMode: false,
    pdfUrl: null as string | null,
    editingUuid: null as string | null,
    
    activeContextId: null as number | null,
    longPressTimer: undefined as number | undefined,

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

    handleLongPressStart(id: number) {
      this.longPressTimer = window.setTimeout(() => { this.activeContextId = id; }, 600);
    },
    handleLongPressEnd() {
      if (this.longPressTimer) {
        window.clearTimeout(this.longPressTimer);
      }
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

    isToolbarOpen: localStorage.getItem('isToolbarOpen') !== 'false',
    toggleToolbar() {
      this.isToolbarOpen = !this.isToolbarOpen;
      localStorage.setItem('isToolbarOpen', this.isToolbarOpen.toString());
    },

    previewImages: [] as string[],
    previewIndex: 0,
    imgStyles: { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' } as any,

    newName: '',
    newSpace: '',
    newLinks: [{ url: '' }],
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
      if (!confirm(this.t('deleteEventConfirm'))) return;
      await db.events.delete(id);
      await db.circles.where('eventId').equals(id).delete();
      await db.eventOrders.delete(id);
      await this.init();
      this.activeContextId = null;
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
      
      this.isFormOpen = false;
      this.editingUuid = null;
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
      if (!confirm(`${this.selectedUuids.length}${this.t('deleteSelectedConfirm')}`)) return;
      await db.circles.bulkDelete(this.selectedUuids);
      
      const orderRecord = await db.eventOrders.get(this.currentEvent!.id!);
      if (orderRecord) {
        orderRecord.circleUuids = orderRecord.circleUuids.filter(u => !this.selectedUuids.includes(u));
        await db.eventOrders.put(orderRecord);
      }
      
      this.selectedUuids = [];
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
        this.newItems.push({ name: '', price: 0, quantity: 1, isChecked: false });
      }
    },
    get totalPrice(): number {
      return this.circles.reduce((sum, c) => sum + c.items.reduce((iSum, item) => iSum + ((Number(item.price) || 0) * (Number(item.quantity) || 1)), 0), 0);
    },
    async exportData() {
      if (!this.currentEvent || !this.currentEvent.id) return;
      const orderRecord = await db.eventOrders.get(this.currentEvent.id);
      const data = {
        event: this.currentEvent,
        circles: this.circles,
        eventOrders: orderRecord
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${this.currentEvent.name}.json`; a.click();
    },
    async importData(e: any) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const data = JSON.parse(reader.result as string);
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

        await this.init();
      };
      reader.readAsText(file);
    },
  }));
});

Alpine.start();