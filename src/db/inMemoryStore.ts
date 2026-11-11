import crypto from 'node:crypto';

export class InMemoryDbStore {
  printers: Map<string, any> = new Map();
  capabilities: Map<string, any> = new Map();
  users: Map<string, any> = new Map();
  qrSessions: Map<string, any> = new Map();
  documentAssets: Map<string, any> = new Map();
  uploadSessions: Map<string, any> = new Map();
  assetVersions: Map<string, any> = new Map();
  aiTransformations: Map<string, any> = new Map();
  printJobs: Map<string, any> = new Map();
  printSettings: Map<string, any> = new Map();
  priceQuotes: Map<string, any> = new Map();
  razorpayOrders: Map<string, any> = new Map();
  paymentEvents: Map<string, any> = new Map();
  printerAgents: Map<string, any> = new Map();
  printerDispatches: Map<string, any> = new Map();
  auditEvents: Map<string, any> = new Map();

  constructor() {
    this.seedDefaultData();
  }

  seedDefaultData() {
    // 1. Seed Printers
    const cap1 = {
      id: 'cap-1',
      printerId: 'library-a4-01',
      supportsColor: true,
      supportsMono: true,
      supportsDuplex: true,
      supportedPageSizes: ['A4'],
      maxDpi: 1200,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.capabilities.set('library-a4-01', cap1);

    this.printers.set('library-a4-01', {
      id: 'library-a4-01',
      name: 'Central Library Color Multi-Function Printer',
      location: 'Main Library 1st Floor - Kiosk Area',
      status: 'online',
      lastHeartbeatAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      capabilities: cap1,
    });

    const cap2 = {
      id: 'cap-2',
      printerId: 'lab-mono-01',
      supportsColor: false,
      supportsMono: true,
      supportsDuplex: true,
      supportedPageSizes: ['A4'],
      maxDpi: 600,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.capabilities.set('lab-mono-01', cap2);

    this.printers.set('lab-mono-01', {
      id: 'lab-mono-01',
      name: 'Computer Science Lab Mono High-Speed Printer',
      location: 'CS Building Room 204',
      status: 'online',
      lastHeartbeatAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      capabilities: cap2,
    });

    // 2. Seed Users
    this.users.set('admin@smartqrprint.local', {
      id: 'mock-user-admin',
      email: 'admin@smartqrprint.local',
      role: 'admin',
      name: 'System Administrator',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    this.users.set('customer@smartqrprint.local', {
      id: 'mock-user-customer',
      email: 'customer@smartqrprint.local',
      role: 'customer',
      name: 'Jane Customer',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    this.users.set('operator@smartqrprint.local', {
      id: 'mock-user-printer_operator',
      email: 'operator@smartqrprint.local',
      role: 'printer_operator',
      name: 'Print Operator',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  createProxy(): any {
    const store = this;

    return {
      printer: {
        findMany: async () => {
          return Array.from(store.printers.values()).map((p) => ({
            ...p,
            capabilities: store.capabilities.get(p.id) || null,
          }));
        },
        findUnique: async (args: any) => {
          const p = store.printers.get(args.where.id);
          if (!p) return null;
          return {
            ...p,
            capabilities: store.capabilities.get(p.id) || null,
          };
        },
        update: async (args: any) => {
          const p = store.printers.get(args.where.id);
          if (!p) throw new Error('Printer not found');
          Object.assign(p, args.data, { updatedAt: new Date() });
          return p;
        },
        upsert: async (args: any) => {
          const existing = store.printers.get(args.where.id);
          if (existing) {
            Object.assign(existing, args.update, { updatedAt: new Date() });
            return existing;
          }
          const created = { id: args.where.id, ...args.create, createdAt: new Date(), updatedAt: new Date() };
          store.printers.set(args.where.id, created);
          return created;
        },
      },
      printerCapability: {
        findUnique: async (args: any) => {
          return store.capabilities.get(args.where.printerId) || null;
        },
        upsert: async (args: any) => {
          const existing = store.capabilities.get(args.where.printerId);
          if (existing) {
            Object.assign(existing, args.update, { updatedAt: new Date() });
            return existing;
          }
          const created = { id: crypto.randomUUID(), ...args.create, createdAt: new Date(), updatedAt: new Date() };
          store.capabilities.set(args.where.printerId, created);
          return created;
        },
      },
      user: {
        findFirst: async (args: any) => {
          const email = args?.where?.email;
          if (email && store.users.has(email)) {
            return store.users.get(email);
          }
          for (const u of store.users.values()) {
            if (args.where?.id && u.id === args.where.id) return u;
            if (args.where?.email && u.email === args.where.email) return u;
          }
          return null;
        },
        findUnique: async (args: any) => {
          if (args.where?.email) return store.users.get(args.where.email) || null;
          for (const u of store.users.values()) {
            if (args.where?.id && u.id === args.where.id) return u;
          }
          return null;
        },
        upsert: async (args: any) => {
          const email = args.where.email;
          const existing = store.users.get(email);
          if (existing) {
            Object.assign(existing, args.update, { updatedAt: new Date() });
            return existing;
          }
          const created = { id: crypto.randomUUID(), email, ...args.create, createdAt: new Date(), updatedAt: new Date() };
          store.users.set(email, created);
          return created;
        },
      },
      qrSession: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const session = { id, ...args.data, createdAt: new Date() };
          store.qrSessions.set(id, session);
          return session;
        },
        findUnique: async (args: any) => {
          const s = store.qrSessions.get(args.where.id);
          if (!s) return null;
          const printer = store.printers.get(s.printerId);
          return {
            ...s,
            printer: printer ? { ...printer, capabilities: store.capabilities.get(printer.id) } : null,
          };
        },
        update: async (args: any) => {
          const s = store.qrSessions.get(args.where.id);
          if (!s) throw new Error('Session not found');
          Object.assign(s, args.data);
          return s;
        },
      },
      documentAsset: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const asset = {
            id,
            status: args.data.status || 'pending_upload',
            isDeleted: args.data.isDeleted ?? false,
            deletedAt: args.data.deletedAt ?? null,
            ...args.data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          store.documentAssets.set(id, asset);
          return asset;
        },
        findUnique: async (args: any) => {
          const a = store.documentAssets.get(args.where.id);
          if (!a) return null;
          if (args.where?.isDeleted !== undefined && a.isDeleted !== args.where.isDeleted) return null;
          const versions = Array.from(store.assetVersions.values()).filter((v) => v.assetId === a.id);
          return {
            ...a,
            versions,
            _count: { versions: versions.length },
          };
        },
        findFirst: async (args: any) => {
          for (const a of store.documentAssets.values()) {
            if (args.where?.id && a.id !== args.where.id) continue;
            if (args.where?.userId && a.userId !== args.where.userId) continue;
            if (args.where?.storageKey && a.storageKey !== args.where.storageKey) continue;
            if (args.where?.isDeleted !== undefined && a.isDeleted !== args.where.isDeleted) continue;
            const versions = Array.from(store.assetVersions.values()).filter((v) => v.assetId === a.id);
            return {
              ...a,
              versions,
              _count: { versions: versions.length },
            };
          }
          return null;
        },
        findMany: async (args: any) => {
          let list = Array.from(store.documentAssets.values());
          if (args?.where?.userId) list = list.filter((a) => a.userId === args.where.userId);
          if (args?.where?.isDeleted !== undefined) list = list.filter((a) => a.isDeleted === args.where.isDeleted);
          if (args?.where?.status) list = list.filter((a) => a.status === args.where.status);
          return list;
        },
        update: async (args: any) => {
          const a = store.documentAssets.get(args.where.id);
          if (!a) throw new Error('DocumentAsset not found');
          Object.assign(a, args.data, { updatedAt: new Date() });
          return a;
        },
      },
      uploadSession: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const session = {
            id,
            status: args.data.status || 'pending',
            ...args.data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          store.uploadSessions.set(id, session);
          return session;
        },
        findUnique: async (args: any) => {
          let s = args.where?.id ? store.uploadSessions.get(args.where.id) : null;
          if (!s && args.where?.storageKey) {
            for (const sess of store.uploadSessions.values()) {
              if (sess.storageKey === args.where.storageKey) {
                s = sess;
                break;
              }
            }
          }
          if (!s && args.where?.idempotencyKey) {
            for (const sess of store.uploadSessions.values()) {
              if (sess.idempotencyKey === args.where.idempotencyKey) {
                s = sess;
                break;
              }
            }
          }
          if (!s) return null;
          const asset = store.documentAssets.get(s.assetId);
          return {
            ...s,
            asset,
          };
        },
        findFirst: async (args: any) => {
          for (const s of store.uploadSessions.values()) {
            if (args.where?.id && s.id !== args.where.id) continue;
            if (args.where?.assetId && s.assetId !== args.where.assetId) continue;
            if (args.where?.userId && s.userId !== args.where.userId) continue;
            if (args.where?.storageKey && s.storageKey !== args.where.storageKey) continue;
            if (args.where?.idempotencyKey && s.idempotencyKey !== args.where.idempotencyKey) continue;
            const asset = store.documentAssets.get(s.assetId);
            return {
              ...s,
              asset,
            };
          }
          return null;
        },
        findMany: async (args: any) => {
          let list = Array.from(store.uploadSessions.values());
          if (args?.where?.status) {
            list = list.filter((s) => s.status === args.where.status);
          }
          if (args?.where?.expiresAt?.lt) {
            list = list.filter((s) => s.expiresAt < args.where.expiresAt.lt);
          }
          return list;
        },
        update: async (args: any) => {
          const s = store.uploadSessions.get(args.where.id);
          if (!s) throw new Error('UploadSession not found');
          Object.assign(s, args.data, { updatedAt: new Date() });
          return s;
        },
        deleteMany: async () => ({ count: 0 }),
      },
      assetVersion: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const version = {
            id,
            status: args.data.status || 'ready',
            ...args.data,
            createdAt: new Date(),
          };
          store.assetVersions.set(id, version);
          return version;
        },
        findMany: async (args: any) => {
          let list = Array.from(store.assetVersions.values()).filter((v) => v.assetId === args.where.assetId);
          if (args?.orderBy?.versionNumber === 'desc') {
            list.sort((a, b) => b.versionNumber - a.versionNumber);
          } else {
            list.sort((a, b) => a.versionNumber - b.versionNumber);
          }
          return list;
        },
        findUnique: async (args: any) => {
          const v = store.assetVersions.get(args.where.id);
          if (!v) return null;
          const asset = store.documentAssets.get(v.assetId);
          return {
            ...v,
            asset,
          };
        },
        update: async (args: any) => {
          const v = store.assetVersions.get(args.where.id);
          if (!v) throw new Error('AssetVersion not found');
          Object.assign(v, args.data);
          return v;
        },
      },
      aiTransformation: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const t = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
          store.aiTransformations.set(id, t);
          return t;
        },
        findUnique: async (args: any) => {
          const t = store.aiTransformations.get(args.where.id);
          if (!t) return null;
          const asset = store.documentAssets.get(t.assetId);
          const versions = Array.from(store.assetVersions.values()).filter((v) => v.assetId === t.assetId);
          const sourceVersion = store.assetVersions.get(t.sourceVersionId);
          return {
            ...t,
            asset: asset ? { ...asset, versions } : null,
            sourceVersion,
          };
        },
        update: async (args: any) => {
          const t = store.aiTransformations.get(args.where.id);
          if (!t) throw new Error('Transformation not found');
          Object.assign(t, args.data, { updatedAt: new Date() });
          return t;
        },
      },
      printJob: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const job = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
          store.printJobs.set(id, job);
          return job;
        },
        findUnique: async (args: any) => {
          const job = store.printJobs.get(args.where.id);
          if (!job) return null;
          const settings = store.printSettings.get(job.id);
          const printer = store.printers.get(job.printerId);
          const assetVersion = store.assetVersions.get(job.assetVersionId);
          const quotes = Array.from(store.priceQuotes.values()).filter((q) => q.printJobId === job.id);
          const rzpOrders = Array.from(store.razorpayOrders.values()).filter((o) => o.printJobId === job.id);
          const dispatches = Array.from(store.printerDispatches.values()).filter((d) => d.printJobId === job.id);

          return {
            ...job,
            settings,
            printer: printer ? { ...printer, capabilities: store.capabilities.get(printer.id) } : null,
            assetVersion,
            priceQuotes: quotes,
            razorpayOrders: rzpOrders,
            dispatches,
          };
        },
        findFirst: async (args: any) => {
          for (const job of store.printJobs.values()) {
            if (args.where?.printerId && job.printerId !== args.where.printerId) continue;
            if (args.where?.status && job.status !== args.where.status) continue;
            const settings = store.printSettings.get(job.id);
            const assetVersion = store.assetVersions.get(job.assetVersionId);
            const asset = assetVersion ? store.documentAssets.get(assetVersion.assetId) : null;
            return {
              ...job,
              settings,
              assetVersion: assetVersion ? { ...assetVersion, asset } : null,
            };
          }
          return null;
        },
        findMany: async (args: any) => {
          let jobs = Array.from(store.printJobs.values());
          if (args?.where?.userId) jobs = jobs.filter((j) => j.userId === args.where.userId);
          if (args?.where?.printerId) jobs = jobs.filter((j) => j.printerId === args.where.printerId);
          if (args?.where?.status) jobs = jobs.filter((j) => j.status === args.where.status);

          return jobs.map((job) => {
            const settings = store.printSettings.get(job.id);
            const printer = store.printers.get(job.printerId);
            const assetVersion = store.assetVersions.get(job.assetVersionId);
            const quotes = Array.from(store.priceQuotes.values()).filter((q) => q.printJobId === job.id);
            return {
              ...job,
              settings,
              printer,
              assetVersion,
              priceQuotes: quotes,
            };
          });
        },
        update: async (args: any) => {
          const job = store.printJobs.get(args.where.id);
          if (!job) throw new Error('Job not found');
          Object.assign(job, args.data, { updatedAt: new Date() });
          return job;
        },
      },
      printSettings: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const s = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
          store.printSettings.set(args.data.printJobId, s);
          return s;
        },
      },
      priceQuote: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const q = { id, ...args.data, createdAt: new Date() };
          store.priceQuotes.set(id, q);
          return q;
        },
      },
      razorpayOrder: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const o = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
          store.razorpayOrders.set(args.data.razorpayOrderId, o);
          return o;
        },
        findUnique: async (args: any) => {
          const o = store.razorpayOrders.get(args.where.razorpayOrderId);
          if (!o) return null;
          const job = store.printJobs.get(o.printJobId);
          return {
            ...o,
            printJob: job,
          };
        },
        update: async (args: any) => {
          let found: any = null;
          for (const o of store.razorpayOrders.values()) {
            if (o.id === args.where.id || o.razorpayOrderId === args.where.razorpayOrderId) {
              found = o;
              break;
            }
          }
          if (!found) throw new Error('Order not found');
          Object.assign(found, args.data, { updatedAt: new Date() });
          return found;
        },
      },
      paymentEvent: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const e = { id, ...args.data, createdAt: new Date() };
          store.paymentEvents.set(args.data.eventId, e);
          return e;
        },
        findUnique: async (args: any) => {
          return store.paymentEvents.get(args.where.eventId) || null;
        },
        upsert: async (args: any) => {
          const existing = store.paymentEvents.get(args.where.eventId);
          if (existing) return existing;
          const created = { id: crypto.randomUUID(), ...args.create, createdAt: new Date() };
          store.paymentEvents.set(args.where.eventId, created);
          return created;
        },
      },
      printerAgent: {
        findFirst: async () => null,
        findUnique: async () => null,
        updateMany: async () => ({ count: 1 }),
        upsert: async (args: any) => {
          return { id: args.where.id, ...args.create };
        },
      },
      printerDispatch: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const d = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
          store.printerDispatches.set(id, d);
          return d;
        },
        update: async (args: any) => {
          const d = store.printerDispatches.get(args.where.id);
          if (!d) throw new Error('Dispatch not found');
          Object.assign(d, args.data, { updatedAt: new Date() });
          return d;
        },
      },
      auditEvent: {
        create: async (args: any) => {
          const id = args.data.id || crypto.randomUUID();
          const evt = { id, ...args.data, createdAt: new Date() };
          store.auditEvents.set(id, evt);
          return evt;
        },
        findMany: async (args: any) => {
          let list = Array.from(store.auditEvents.values());
          if (args?.where?.entityId) list = list.filter((e) => e.entityId === args.where.entityId);
          if (args?.where?.entityType) list = list.filter((e) => e.entityType === args.where.entityType);
          if (args?.where?.userId) list = list.filter((e) => e.userId === args.where.userId);
          if (args?.where?.action) list = list.filter((e) => e.action === args.where.action);
          return list;
        },
      },
      $transaction: async (fnOrArray: any) => {
        if (typeof fnOrArray === 'function') {
          return fnOrArray(store.createProxy());
        }
        return Promise.all(fnOrArray);
      },
      $queryRaw: async () => [{ 1: 1 }],
      $disconnect: async () => {},
    };
  }
}
