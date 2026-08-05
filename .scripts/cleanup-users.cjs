#!/usr/bin/env node

const { Pool } = require('pg');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Handle command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');

// Parse database URL from command line
let dbUrl = null;
const dbUrlIndex = args.findIndex(arg => arg === '--db-url');
if (dbUrlIndex !== -1 && dbUrlIndex + 1 < args.length) {
  dbUrl = args[dbUrlIndex + 1];
  console.log('🔗 Using custom database URL from command line');
}

const databaseUrl = new URL(
  dbUrl || process.env.API_IDENTITY_DATABASE_URL
);
const databaseSchema = databaseUrl.searchParams.get('schema') || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
  throw new Error(`Invalid PostgreSQL schema: ${databaseSchema}`);
}
databaseUrl.searchParams.delete('schema');

const pool = new Pool({
  connectionString: databaseUrl.toString(),
  options: `-c search_path=${databaseSchema},public`
});

async function cleanupUsers() {
  try {
    console.log('🔍 Starting user cleanup process...');
    
    // Calculate the cutoff time (24 hours ago)
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`📅 Cutoff time: ${cutoffTime.toISOString()}`);
    
    // Find users that meet the cleanup criteria
    const { rows: usersToCleanup } = await pool.query(
      `SELECT
         ref,
         email,
         name,
         created_at AS "createdAt",
         phone_number AS "phoneNumber",
         phone_number_verified AS "phoneNumberVerified",
         email_verified AS "emailVerified"
       FROM users
       WHERE phone_number_verified = false AND created_at < $1`,
      [cutoffTime]
    );
    
    console.log(`📊 Found ${usersToCleanup.length} users eligible for cleanup`);
    
    if (usersToCleanup.length === 0) {
      console.log('✅ No users to cleanup. Database is clean!');
      return;
    }
    
    // Display users that will be deleted (for verification)
    console.log('\n📋 Users to be deleted:');
    usersToCleanup.forEach((user, index) => {
      console.log(`${index + 1}. ${user.email} (${user.name}) - Created: ${user.createdAt.toISOString()}`);
    });
    
    // Handle dry-run mode
    if (isDryRun) {
      console.log('\n🔍 DRY RUN MODE: No users were actually deleted');
      console.log(`📊 Would have deleted ${usersToCleanup.length} users`);
      return;
    }
    
    // Ask for confirmation (only if running interactively and not force mode)
    if (process.stdin.isTTY && !isForce) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise((resolve) => {
        rl.question('\n❓ Do you want to proceed with deletion? (yes/no): ', resolve);
      });
      rl.close();
      
      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        console.log('❌ Cleanup cancelled by user');
        return;
      }
    }
    
    // Delete users
    console.log('\n🗑️  Deleting users...');
    const { rowCount: deletedCount } = await pool.query(
      `DELETE FROM users
       WHERE ref = ANY($1::text[])
         AND phone_number_verified = false
         AND created_at < $2
       RETURNING ref`,
      [usersToCleanup.map(({ ref }) => ref), cutoffTime]
    );
    
    console.log(`✅ Successfully deleted ${deletedCount} users`);
    
    // Verify cleanup
    const { rowCount } = await pool.query(
      `SELECT ref
       FROM users
       WHERE phone_number_verified = false
          AND created_at < $1`,
      [cutoffTime]
    );
    
    console.log(`🔍 Verification: ${rowCount} users still meet cleanup criteria`);
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node cleanup-users.cjs [options]

Options:
  --dry-run              Show what would be deleted without actually deleting
  --force                Skip confirmation prompt
  --db-url <url>         Override database URL (optional)
  --help, -h             Show this help message

Examples:
  node cleanup-users.cjs --dry-run                                    # Preview what would be deleted
  node cleanup-users.cjs --force                                      # Delete without confirmation
  node cleanup-users.cjs --db-url "postgresql://user:pass@host:5432/db"  # Use custom database
  node cleanup-users.cjs                                              # Delete with confirmation prompt
`);
  process.exitCode = 0;
}

// Run the cleanup
cleanupUsers()
  .then(() => {
    console.log('🎉 Cleanup process completed');
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('💥 Cleanup failed:', error);
    process.exitCode = 1;
  });
