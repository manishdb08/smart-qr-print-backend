import crypto from 'node:crypto';
import { prisma } from './client.js';
import { config } from '../config/index.js';

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export async function seedPrintersAndUsers() {
  console.log('🌱 Starting database seed...');

  // 1. Seed Seed Users
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@smartqrprint.local' },
    update: {},
    create: {
      email: 'admin@smartqrprint.local',
      name: 'System Administrator',
      role: 'admin',
    },
  });

  const operatorUser = await prisma.user.upsert({
    where: { email: 'operator@smartqrprint.local' },
    update: {},
    create: {
      email: 'operator@smartqrprint.local',
      name: 'Library Print Operator',
      role: 'printer_operator',
    },
  });

  const testCustomer = await prisma.user.upsert({
    where: { email: 'customer@smartqrprint.local' },
    update: {},
    create: {
      email: 'customer@smartqrprint.local',
      name: 'Jane Customer',
      role: 'customer',
    },
  });

  console.log(`✅ Seeded users: Admin (${adminUser.id}), Operator (${operatorUser.id}), Customer (${testCustomer.id})`);

  // 2. Seed Printer 1: library-a4-01 (mono and color, duplex, A4)
  const printer1 = await prisma.printer.upsert({
    where: { id: 'library-a4-01' },
    update: {
      name: 'Central Library Color Multi-Function Printer',
      location: 'Main Library 1st Floor - Kiosk Area',
      status: 'online',
    },
    create: {
      id: 'library-a4-01',
      name: 'Central Library Color Multi-Function Printer',
      location: 'Main Library 1st Floor - Kiosk Area',
      status: 'online',
    },
  });

  await prisma.printerCapability.upsert({
    where: { printerId: 'library-a4-01' },
    update: {
      supportsColor: true,
      supportsMono: true,
      supportsDuplex: true,
      supportedPageSizes: ['A4'],
      maxDpi: 1200,
    },
    create: {
      printerId: 'library-a4-01',
      supportsColor: true,
      supportsMono: true,
      supportsDuplex: true,
      supportedPageSizes: ['A4'],
      maxDpi: 1200,
    },
  });

  // 3. Seed Printer 2: lab-mono-01 (mono only, duplex, A4)
  const printer2 = await prisma.printer.upsert({
    where: { id: 'lab-mono-01' },
    update: {
      name: 'Computer Science Lab Mono High-Speed Printer',
      location: 'CS Building Room 204',
      status: 'online',
    },
    create: {
      id: 'lab-mono-01',
      name: 'Computer Science Lab Mono High-Speed Printer',
      location: 'CS Building Room 204',
      status: 'online',
    },
  });

  await prisma.printerCapability.upsert({
    where: { printerId: 'lab-mono-01' },
    update: {
      supportsColor: false,
      supportsMono: true,
      supportsDuplex: true,
      supportedPageSizes: ['A4'],
      maxDpi: 600,
    },
    create: {
      printerId: 'lab-mono-01',
      supportsColor: false,
      supportsMono: true,
      supportsDuplex: true,
      supportedPageSizes: ['A4'],
      maxDpi: 600,
    },
  });

  // 4. Seed Printer Agents
  const agentSecretHash = hashSecret(config.PRINT_AGENT_SHARED_SECRET);

  await prisma.printerAgent.upsert({
    where: { id: 'agent-library-a4-01' },
    update: {
      secretHash: agentSecretHash,
      isBlocked: false,
    },
    create: {
      id: 'agent-library-a4-01',
      printerId: 'library-a4-01',
      agentName: 'Library Local Agent v1.0',
      secretHash: agentSecretHash,
      isBlocked: false,
    },
  });

  await prisma.printerAgent.upsert({
    where: { id: 'agent-lab-mono-01' },
    update: {
      secretHash: agentSecretHash,
      isBlocked: false,
    },
    create: {
      id: 'agent-lab-mono-01',
      printerId: 'lab-mono-01',
      agentName: 'CS Lab Local Agent v1.0',
      secretHash: agentSecretHash,
      isBlocked: false,
    },
  });

  console.log('✅ Seeded printers and capabilities:');
  console.log('   - library-a4-01: mono=true, color=true, duplex=true, sizes=["A4"]');
  console.log('   - lab-mono-01:   mono=true, color=false, duplex=true, sizes=["A4"]');
  console.log('✅ Seeded printer agents.');
  console.log('✨ Seed completed successfully.');
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seedPrintersAndUsers()
    .catch((err) => {
      console.error('❌ Error during seeding:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
