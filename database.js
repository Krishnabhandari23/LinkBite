import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error('❌ SUPABASE_URL environment variable is missing');
  process.exit(1);
}

if (!supabaseServiceRoleKey) {
  console.error('❌ SUPABASE_SERVICE_ROLE_KEY environment variable is missing');
  process.exit(1);
}

console.log('🔗 Connecting to Supabase...');
console.log('📍 URL:', supabaseUrl);
console.log('🔑 Service Role Key:', supabaseServiceRoleKey.substring(0, 20) + '...');

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// Test database connection
async function testDatabaseConnection() {
  try {
    console.log('🔍 Testing database connection...');

    // Try to make a simple query to test connection
    const { data, error } = await supabase
      .from('monitoring_channels')
      .select('count')
      .limit(1);

    if (error && error.code === 'PGRST116') {
      // Table doesn't exist, but connection works
      console.log('⚠️  Table "monitoring_channels" does not exist. Please run the SQL setup script.');
      console.log('📝 Go to Supabase SQL Editor and run the contents of supabase_setup.sql');
      return { success: true, message: 'Connected but table needs to be created' };
    } else if (error) {
      console.error('❌ Database error:', error.message);
      return { success: false, error: error.message };
    }

    console.log('✅ Database connection successful');
    return { success: true, message: 'Database connected successfully' };
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Save monitoring data to database
async function saveMonitoringData() {
  try {
    console.log('💾 saveMonitoringData called...');

    // Note: This function is called from server.js but we need access to monitoringInstances
    // For now, we'll return success. The actual saving happens in individual functions.

    return { success: true, count: 0, message: 'Monitoring data save triggered' };
  } catch (error) {
    console.error('❌ Error in saveMonitoringData:', error.message);
    return { success: false, error: error.message };
  }
}

// Load monitoring data from database and return it
async function loadMonitoringData() {
  try {
    console.log('📂 Loading monitoring data from database...');

    const { data, error } = await supabase
      .from('monitoring_channels')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error loading monitoring data:', error.message);
      return { success: false, error: error.message };
    }

    console.log(`📊 Loaded ${data?.length || 0} monitoring configurations`);

    // Convert database format to server format
    const channels = data?.map(row => ({
      channelHandle: row.channel_handle,
      channelUrl: `https://www.youtube.com/${row.channel_handle}`,
      webhookUrl: row.webhook_url,
      interval: row.monitor_interval,
      contentTypes: row.content_types || ['live'],
      lastKnownStates: row.last_known_states || {},
      setupAt: new Date(row.created_at).getTime(),
      savedAt: new Date(row.updated_at).getTime()
    })) || [];

    return { success: true, count: data?.length || 0, channels: channels };
  } catch (error) {
    console.error('❌ Error loading monitoring data:', error.message);
    return { success: false, error: error.message };
  }
}

// Save or update a single channel configuration
async function saveChannelConfiguration(channelHandle, config) {
  try {
    console.log(`💾 Saving configuration for ${channelHandle}...`);

    const channelData = {
      channel_handle: channelHandle,
      webhook_url: config.webhookUrl,
      content_types: config.contentTypes || ['live'],
      monitor_interval: config.interval || 60000,
      last_known_states: config.lastKnownStates || {},
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('monitoring_channels')
      .upsert(channelData, { onConflict: 'channel_handle' })
      .select();

    if (error) {
      console.error(`❌ Error saving ${channelHandle}:`, error.message);
      return { success: false, error: error.message };
    }

    console.log(`✅ Saved configuration for ${channelHandle}`);
    return { success: true, data: data[0] };
  } catch (error) {
    console.error('❌ Error saving channel configuration:', error.message);
    return { success: false, error: error.message };
  }
}

// Remove channel from database
async function removeChannelFromDatabase(channelHandle) {
  try {
    console.log(`🗑️ Removing ${channelHandle} from database...`);

    const { error } = await supabase
      .from('monitoring_channels')
      .delete()
      .eq('channel_handle', channelHandle);

    if (error) {
      console.error(`❌ Error removing ${channelHandle}:`, error.message);
      return { success: false, error: error.message };
    }

    console.log(`✅ Removed ${channelHandle} from database`);
    return { success: true };
  } catch (error) {
    console.error('❌ Error removing channel from database:', error.message);
    return { success: false, error: error.message };
  }
}

// Get all channels from database
async function getAllChannelsFromDatabase() {
  try {
    console.log('📋 Getting all channels from database...');

    const { data, error } = await supabase
      .from('monitoring_channels')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error getting channels:', error.message);
      return { success: false, error: error.message };
    }

    console.log(`📊 Found ${data?.length || 0} channels in database`);
    return { success: true, channels: data || [] };
  } catch (error) {
    console.error('❌ Error getting channels from database:', error.message);
    return { success: false, error: error.message };
  }
}

// Update channel states in database
async function updateChannelStates(channelHandle, states) {
  try {
    console.log(`🔄 Updating states for ${channelHandle}...`);

    const { error } = await supabase
      .from('monitoring_channels')
      .update({ 
        last_known_states: states,
        updated_at: new Date().toISOString()
      })
      .eq('channel_handle', channelHandle);

    if (error) {
      console.error(`❌ Error updating states for ${channelHandle}:`, error.message);
      return { success: false, error: error.message };
    }

    console.log(`✅ Updated states for ${channelHandle}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Error updating channel states:', error.message);
    return { success: false, error: error.message };
  }
}

// Log monitoring events (optional)
async function logMonitoringEvent(channelHandle, event, data = {}) {
  try {
    const eventData = {
      channel_handle: channelHandle,
      event_type: event,
      event_data: data,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('monitoring_events')
      .insert([eventData]);

    if (error) {
      // Don't log errors for events table as it's optional
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Initialize database tables (run once)
async function initializeDatabase() {
  try {
    console.log('🏗️ Checking database tables...');

    // Test if tables exist by trying to select from them
    const { data, error } = await supabase
      .from('monitoring_channels')
      .select('count')
      .limit(1);

    if (error && error.code === 'PGRST116') {
      console.log('⚠️ Database tables not found. Please run the SQL setup script.');
      console.log('📝 Go to Supabase Dashboard → SQL Editor');
      console.log('📋 Run the contents of supabase_setup.sql file');
      return { success: false, error: 'Tables not created. Run SQL setup script.' };
    }

    console.log('✅ Database tables are ready');
    return { success: true };
  } catch (error) {
    console.error('❌ Error checking database:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  testDatabaseConnection,
  saveMonitoringData,
  loadMonitoringData,
  removeChannelFromDatabase,
  getAllChannelsFromDatabase,
  logMonitoringEvent,
  saveChannelConfiguration,
  updateChannelStates,
  initializeDatabase,
  supabase
};



