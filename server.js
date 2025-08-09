const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dynamic-youtube-server.html'));
});

// Configuration constants
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes
const DEFAULT_MONITOR_INTERVAL = 60 * 1000; // 1 minute default
const DATA_FILE = path.join(__dirname, 'monitoring_data.json');

// Dynamic monitoring state - supports multiple channels
let monitoringInstances = new Map(); // channelHandle -> monitoring instance
let globalCache = new Map(); // channelHandle -> cached data
let persistentChannels = new Map(); // channelHandle -> config data

// Data persistence functions
async function saveMonitoringData() {
    try {
        const dataToSave = {};
        const now = Date.now();
        
        for (const [channelHandle, instance] of monitoringInstances) {
            if (instance.isMonitoring) {
                dataToSave[channelHandle] = {
                    channelHandle: instance.channelHandle,
                    webhookUrl: instance.webhookUrl,
                    interval: instance.interval,
                    contentTypes: instance.contentTypes, // This is now safe
                    lastKnownStates: instance.lastKnownStates,
                    savedAt: now
                };
            }
        }
        
        await fs.writeFile(DATA_FILE, JSON.stringify(dataToSave, null, 2));
        console.log(`💾 Monitoring data saved for ${Object.keys(dataToSave).length} channels`);
    } catch (error) {
        console.error('❌ Error saving monitoring data:', error.message);
    }
}

async function loadMonitoringData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const savedData = JSON.parse(data);
        
        console.log('📂 Loaded monitoring data. Keys:', Object.keys(savedData));
        
        for (const [channelHandle, config] of Object.entries(savedData)) {
            console.log(`🔍 Processing ${channelHandle}...`);
            
            // Debug: Log the timestamp
            console.log('Timestamp (savedAt):', config.savedAt);
            console.log('Is valid timestamp?', !isNaN(new Date(config.savedAt).getTime()));
            
            // Rest of your loading logic...
        }
    } catch (error) {
        console.error('❌ Failed to load channels:', error);
    }
}

// Auto-save monitoring data every 5 minutes
setInterval(saveMonitoringData, 5 * 60 * 1000);

// Monitoring instance structure (enhanced)
class MonitoringInstance {
    constructor(channelHandle, webhookUrl, interval = DEFAULT_MONITOR_INTERVAL, contentTypes = ['live']) {
        this.channelHandle = channelHandle;
        this.channelUrl = `https://www.youtube.com/${channelHandle}`;
        this.webhookUrl = webhookUrl;
        this.interval = interval;
        this.contentTypes = contentTypes; // ['live', 'videos', 'shorts']
        this.isMonitoring = false;
        this.intervalId = null;
        this.lastKnownStates = {
            live: false,
            latestVideoId: null,
            latestShortId: null
        };
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 5;
        this.lastChecked = null;
        this.startedAt = null;
    }

    async start() {
        if (this.isMonitoring) {
            return { success: false, message: 'Already monitoring this channel' };
        }

        console.log(`🚀 Starting monitoring for ${this.channelHandle} (${this.contentTypes.join(', ')})`);
        this.isMonitoring = true;
        this.consecutiveErrors = 0;
        this.startedAt = Date.now();
        
        // Start monitoring immediately
        await this.checkContent();
        
        // Set up interval
        this.intervalId = setInterval(() => this.checkContent(), this.interval);
        
        // Save to persistent storage
        await saveMonitoringData();
        
        return { success: true, message: 'Monitoring started successfully' };
    }

    stop() {
        if (!this.isMonitoring) {
            return { success: false, message: 'Not currently monitoring' };
        }

        console.log(`🛑 Stopping monitoring for ${this.channelHandle}`);
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        this.isMonitoring = false;
        this.consecutiveErrors = 0;
        this.startedAt = null;
        
        return { success: true, message: 'Monitoring stopped successfully' };
    }

    async checkContent() {
        try {
            console.log(`🔍 Checking content for ${this.channelHandle}...`);
            
            for (const contentType of this.contentTypes) {
                await this.checkContentType(contentType);
            }
            
            // Reset consecutive errors on successful check
            this.consecutiveErrors = 0;
            this.lastChecked = Date.now();

        } catch (error) {
            console.error(`❌ Monitoring error for ${this.channelHandle}:`, error.message);
            this.consecutiveErrors++;
            
            // Stop monitoring if too many consecutive errors
            if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                console.error(`❌ Too many consecutive errors for ${this.channelHandle}, stopping monitoring`);
                this.stop();
                
                // Send error webhook
                await this.sendWebhookNotification({
                    event: 'monitoring_error',
                    error: 'Monitoring stopped due to consecutive errors',
                    consecutiveErrors: this.consecutiveErrors
                });
                
                // Remove from monitoring instances and persistent storage
                monitoringInstances.delete(this.channelHandle);
                persistentChannels.delete(this.channelHandle);
                await saveMonitoringData();
            }
        }
    }

    async checkContentType(contentType) {
        let result;
        
        switch (contentType) {
            case 'live':
                result = await checkIfChannelIsLive(this.channelHandle);
                await this.handleLiveStatusChange(result);
                break;
            case 'videos':
                result = await getLatestVideos(this.channelHandle, 1);
                await this.handleNewVideo(result);
                break;
            case 'shorts':
                result = await getLatestShorts(this.channelHandle, 1);
                await this.handleNewShort(result);
                break;
        }
    }

    async handleLiveStatusChange(liveStatus) {
        if (liveStatus.isLive !== this.lastKnownStates.live) {
            console.log(`🔄 Live status changed for ${this.channelHandle}: ${this.lastKnownStates.live} → ${liveStatus.isLive}`);
            
            if (liveStatus.isLive && liveStatus.liveUrl) {
                // Channel went LIVE
                console.log(`🎉 ${this.channelHandle} just went LIVE!`);
                
                const shortenerResult = await shortenUrl(liveStatus.liveUrl);
                
                // Update cache
                globalCache.set(this.channelHandle, {
                    ...globalCache.get(this.channelHandle) || {},
                    shorturl: shortenerResult.shorturl,
                    lastChecked: Date.now(),
                    isLive: true,
                    liveUrl: liveStatus.liveUrl,
                    title: liveStatus.title,
                    thumbnail: liveStatus.thumbnail
                });

                // Send webhook notification
                await this.sendWebhookNotification({
                    event: 'stream_started',
                    isLive: true,
                    shorturl: shortenerResult.shorturl,
                    originalUrl: liveStatus.liveUrl,
                    title: liveStatus.title,
                    shortenerService: shortenerResult.service,
                    method: liveStatus.method,
                    thumbnail: liveStatus.thumbnail
                });

            } else if (!liveStatus.isLive && this.lastKnownStates.live) {
                // Channel went OFFLINE
                console.log(`📺 ${this.channelHandle} went offline`);
                
                // Update cache
                globalCache.set(this.channelHandle, {
                    ...globalCache.get(this.channelHandle) || {},
                    isLive: false,
                    lastChecked: Date.now()
                });
                
                // Send webhook notification
                await this.sendWebhookNotification({
                    event: 'stream_ended',
                    isLive: false,
                    message: 'Stream has ended'
                });
            }
            
            this.lastKnownStates.live = liveStatus.isLive;
            await saveMonitoringData(); // Save state changes
        }
    }

    async handleNewVideo(videoResult) {
        if (videoResult.success && videoResult.videos.length > 0) {
            const latestVideo = videoResult.videos[0];
            
            if (this.lastKnownStates.latestVideoId !== latestVideo.videoId) {
                console.log(`📹 New video detected for ${this.channelHandle}: ${latestVideo.title}`);
                
                const shortenerResult = await shortenUrl(latestVideo.url);
                
                // Send webhook notification
                await this.sendWebhookNotification({
                    event: 'new_video',
                    title: latestVideo.title,
                    shorturl: shortenerResult.shorturl,
                    originalUrl: latestVideo.url,
                    thumbnail: latestVideo.thumbnail,
                    publishedAt: latestVideo.publishedAt,
                    viewCount: latestVideo.viewCount
                });
                
                this.lastKnownStates.latestVideoId = latestVideo.videoId;
                await saveMonitoringData(); // Save state changes
            }
        }
    }

    async handleNewShort(shortResult) {
        if (shortResult.success && shortResult.shorts.length > 0) {
            const latestShort = shortResult.shorts[0];
            
            if (this.lastKnownStates.latestShortId !== latestShort.videoId) {
                console.log(`🎬 New short detected for ${this.channelHandle}: ${latestShort.title}`);
                
                const shortenerResult = await shortenUrl(latestShort.url);
                
                // Send webhook notification
                await this.sendWebhookNotification({
                    event: 'new_short',
                    title: latestShort.title,
                    shorturl: shortenerResult.shorturl,
                    originalUrl: latestShort.url,
                    thumbnail: latestShort.thumbnail,
                    publishedAt: latestShort.publishedAt,
                    viewCount: latestShort.viewCount
                });
                
                this.lastKnownStates.latestShortId = latestShort.videoId;
                await saveMonitoringData(); // Save state changes
            }
        }
    }

    async sendWebhookNotification(data) {
        if (!this.webhookUrl) {
            console.log(`⚠️  No webhook URL configured for ${this.channelHandle}, skipping notification`);
            return false;
        }

        try {
            console.log(`📤 Sending webhook notification for ${this.channelHandle}...`);

            let payload = formatDiscordMessage({
                ...data,
                channelHandle: this.channelHandle,
                channelUrl: this.channelUrl
            });

            const response = await axios.post(this.webhookUrl, payload, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'YouTube-Live-Monitor-Pro/2.0'
                }
            });

            if (response.status >= 200 && response.status < 300) {
                console.log(`✅ Webhook notification sent successfully for ${this.channelHandle}`);
                return true;
            } else {
                console.error(`❌ Webhook failed for ${this.channelHandle} with status:`, response.status);
                return false;
            }
        } catch (error) {
            console.error(`❌ Webhook notification failed for ${this.channelHandle}:`, error.response?.data || error.message);
            return false;
        }
    }

    getStatus() {
        return {
            channelHandle: this.channelHandle,
            channelUrl: this.channelUrl,
            webhookUrl: this.webhookUrl ? this.webhookUrl.replace(/\/[^\/]*$/, '/***') : null,
            isMonitoring: this.isMonitoring,
            contentTypes: this.contentTypes,
            lastKnownStates: this.lastKnownStates,
            consecutiveErrors: this.consecutiveErrors,
            interval: this.interval,
            lastChecked: this.lastChecked ? new Date(this.lastChecked).toISOString() : null,
            startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
            lastKnownLiveStatus: this.lastKnownStates.live
        };
    }
}

// Function to get channel ID from handle
async function getChannelIdFromHandle(handle) {
    try {
        const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
        const response = await axios.get(`https://www.youtube.com/${cleanHandle}`, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = response.data;
        
        // Try to find channel ID in various formats
        const patterns = [
            /"channelId":"([^"]+)"/,
            /"externalId":"([^"]+)"/,
            /channel\/([a-zA-Z0-9_-]{24})/,
            /"browseId":"([^"]+)"/
        ];
        
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
                console.log(`✅ Found channel ID for ${handle}: ${match[1]}`);
                return match[1];
            }
        }
        
        throw new Error('Channel ID not found in page');
    } catch (error) {
        console.error(`❌ Error getting channel ID for ${handle}:`, error.message);
        throw error;
    }
}

// Function to check if channel is live using YouTube API
async function checkIfChannelIsLive(channelHandle) {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            console.log(`⚠️  No YouTube API key found for ${channelHandle}, using fallback method`);
            return await checkLiveStatusFallback(channelHandle);
        }

        console.log(`🔍 Using YouTube API to check live status for ${channelHandle}...`);
        const channelId = await getChannelIdFromHandle(channelHandle);
        
        // Search for live streams from this channel
        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                eventType: 'live',
                type: 'video',
                key: process.env.YOUTUBE_API_KEY,
                maxResults: 1
            },
            timeout: 15000
        });

        if (searchResponse.data.items && searchResponse.data.items.length > 0) {
            const liveVideo = searchResponse.data.items[0];
            const liveUrl = `https://www.youtube.com/watch?v=${liveVideo.id.videoId}`;
            
            console.log(`🎥 Found live stream for ${channelHandle}: ${liveVideo.snippet.title}`);
            return {
                isLive: true,
                liveUrl: liveUrl,
                title: liveVideo.snippet.title,
                thumbnail: liveVideo.snippet.thumbnails?.default?.url,
                videoId: liveVideo.id.videoId,
                method: 'api'
            };
        }

        console.log(`📺 No live streams found via API for ${channelHandle}`);
        return { isLive: false, liveUrl: null };
        
    } catch (error) {
        console.error(`❌ YouTube API failed for ${channelHandle}:`, error.message);
        console.log(`🔄 Trying fallback method for ${channelHandle}...`);
        return await checkLiveStatusFallback(channelHandle);
    }
}

// Function to get latest videos
async function getLatestVideos(channelHandle, maxResults = 10) {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            return await getLatestVideosFallback(channelHandle, maxResults);
        }

        console.log(`🔍 Getting latest videos for ${channelHandle}...`);
        const channelId = await getChannelIdFromHandle(channelHandle);
        
        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                type: 'video',
                order: 'date',
                key: process.env.YOUTUBE_API_KEY,
                maxResults: maxResults
            },
            timeout: 15000
        });

        const videos = searchResponse.data.items.map(item => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails?.default?.url,
            publishedAt: new Date(item.snippet.publishedAt).toLocaleDateString(),
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            viewCount: 'N/A' // View count requires additional API call
        }));

        return {
            success: true,
            videos: videos,
            channel: channelHandle,
            method: 'api'
        };
        
    } catch (error) {
        console.error(`❌ Error getting videos for ${channelHandle}:`, error.message);
        return await getLatestVideosFallback(channelHandle, maxResults);
    }
}

// Function to get latest shorts
async function getLatestShorts(channelHandle, maxResults = 10) {
    try {
        if (!process.env.YOUTUBE_API_KEY) {
            return await getLatestShortsFallback(channelHandle, maxResults);
        }

        console.log(`🔍 Getting latest shorts for ${channelHandle}...`);
        const channelId = await getChannelIdFromHandle(channelHandle);
        
        const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                channelId: channelId,
                type: 'video',
                order: 'date',
                key: process.env.YOUTUBE_API_KEY,
                maxResults: maxResults * 2, // Get more to filter for shorts
                videoDuration: 'short' // Less than 4 minutes
            },
            timeout: 15000
        });

        // Filter for actual shorts (YouTube Shorts are typically under 60 seconds)
        const shorts = searchResponse.data.items
            .filter(item => {
                const title = item.snippet.title.toLowerCase();
                const description = item.snippet.description?.toLowerCase() || '';
                return title.includes('#shorts') || description.includes('#shorts') || 
                       title.includes('short') || description.includes('short');
            })
            .slice(0, maxResults)
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails?.default?.url,
                publishedAt: new Date(item.snippet.publishedAt).toLocaleDateString(),
                url: `https://www.youtube.com/shorts/${item.id.videoId}`,
                viewCount: 'N/A' // View count requires additional API call
            }));

        return {
            success: true,
            shorts: shorts,
            channel: channelHandle,
            method: 'api'
        };
        
    } catch (error) {
        console.error(`❌ Error getting shorts for ${channelHandle}:`, error.message);
        return await getLatestShortsFallback(channelHandle, maxResults);
    }
}

// Fallback methods
async function checkLiveStatusFallback(channelHandle) {
    try {
        console.log(`🔍 Using fallback method to check live status for ${channelHandle}...`);
        
        const cleanHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const channelUrl = `https://www.youtube.com/${cleanHandle}`;
        
        const response = await axios.get(channelUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const html = response.data;
        
        // Look for live stream indicators
        const livePatterns = [
            /"isLiveContent":true.*?"videoId":"([^"]+)"/,
            /"isLive":true.*?"videoId":"([^"]+)"/,
            /watching now.*?"videoId":"([^"]+)"/i,
            /"LIVE".*?"videoId":"([^"]+)"/,
            /"badges":\[{"metadataBadgeRenderer":{"style":"BADGE_STYLE_TYPE_LIVE_NOW".*?"videoId":"([^"]+)"/
        ];
        
        for (const pattern of livePatterns) {
            const match = html.match(pattern);
            if (match) {
                const videoId = match[1];
                const liveUrl = `https://www.youtube.com/watch?v=${videoId}`;
                
                // Try to get title
                const titleMatch = html.match(new RegExp(`"videoId":"${videoId}".*?"title":"([^"]+)"`));
                const title = titleMatch ? titleMatch[1] : 'Live Stream';
                
                console.log(`🎥 Found live stream via fallback for ${channelHandle}: ${title}`);
                return {
                    isLive: true,
                    liveUrl: liveUrl,
                    title: title,
                    videoId: videoId,
                    method: 'fallback'
                };
            }
        }
        
        console.log(`📺 No live streams found via fallback for ${channelHandle}`);
        return { isLive: false, liveUrl: null };
        
    } catch (error) {
        console.error(`❌ Fallback method failed for ${channelHandle}:`, error.message);
        return { isLive: false, liveUrl: null };
    }
}

async function getLatestVideosFallback(channelHandle, maxResults = 10) {
    try {
        console.log(`🔍 Using fallback method to get videos for ${channelHandle}...`);
        
        const cleanHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const channelUrl = `https://www.youtube.com/${cleanHandle}/videos`;
        
        const response = await axios.get(channelUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = response.data;
        const videoIds = [];
        const videoPattern = /"videoId":"([^"]+)"/g;
        let match;
        
        while ((match = videoPattern.exec(html)) !== null && videoIds.length < maxResults) {
            if (!videoIds.includes(match[1])) {
                videoIds.push(match[1]);
            }
        }

        const videos = videoIds.map(videoId => ({
            videoId: videoId,
            title: 'Recent Video',
            thumbnail: `https://img.youtube.com/vi/${videoId}/default.jpg`,
            publishedAt: 'Recent',
            url: `https://www.youtube.com/watch?v=${videoId}`,
            viewCount: 'N/A'
        }));

        return {
            success: true,
            videos: videos,
            channel: channelHandle,
            method: 'fallback'
        };
        
    } catch (error) {
        console.error(`❌ Fallback videos method failed for ${channelHandle}:`, error.message);
        return { success: false, videos: [], channel: channelHandle };
    }
}

async function getLatestShortsFallback(channelHandle, maxResults = 10) {
    try {
        console.log(`🔍 Using fallback method to get shorts for ${channelHandle}...`);
        
        const cleanHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const channelUrl = `https://www.youtube.com/${cleanHandle}/shorts`;
        
        const response = await axios.get(channelUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const html = response.data;
        const shortIds = [];
        const shortPattern = /"videoId":"([^"]+)"/g;
        let match;
        
        while ((match = shortPattern.exec(html)) !== null && shortIds.length < maxResults) {
            if (!shortIds.includes(match[1])) {
                shortIds.push(match[1]);
            }
        }

        const shorts = shortIds.map(videoId => ({
            videoId: videoId,
            title: 'Recent Short',
            thumbnail: `https://img.youtube.com/vi/${videoId}/default.jpg`,
            publishedAt: 'Recent',
            url: `https://www.youtube.com/shorts/${videoId}`,
            viewCount: 'N/A'
        }));

        return {
            success: true,
            shorts: shorts,
            channel: channelHandle,
            method: 'fallback'
        };
        
    } catch (error) {
        console.error(`❌ Fallback shorts method failed for ${channelHandle}:`, error.message);
        return { success: false, shorts: [], channel: channelHandle };
    }
}

// Function to shorten URL using multiple services
async function shortenUrl(longUrl) {
    console.log(`🔗 Attempting to shorten URL: ${longUrl}`);

    const shorteners = [
        {
            name: 'linktw.in',
            methods: [
                {
                    url: 'https://linktw.in/api/url/add',
                    method: 'POST',
                    data: { url: longUrl },
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': process.env.LINKTW_API_KEY 
                    }
                }
            ]
        },
        {
            name: 'TinyURL',
            methods: [
                {
                    url: `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
                    method: 'GET'
                }
            ]
        },
        {
            name: 'is.gd',
            methods: [
                {
                    url: 'https://is.gd/create.php',
                    method: 'POST',
                    data: `format=simple&url=${encodeURIComponent(longUrl)}`,
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            ]
        }
    ];

    for (const shortener of shorteners) {
        for (const config of shortener.methods) {
            try {
                console.log(`🔄 Trying ${shortener.name}...`);

                const axiosConfig = {
                    method: config.method,
                    url: config.url,
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        ...config.headers
                    }
                };

                if (config.data) axiosConfig.data = config.data;

                const response = await axios(axiosConfig);

                let shorturl = null;

                if (typeof response.data === 'string') {
                    shorturl = response.data.trim();
                } else if (response.data) {
                    const fields = ['short_url', 'shorturl', 'shortened_url', 'url', 'link', 'short'];
                    for (const field of fields) {
                        if (response.data[field]) {
                            shorturl = response.data[field];
                            break;
                        }
                    }
                }

                if (shorturl && shorturl.startsWith('http') && shorturl !== longUrl) {
                    console.log(`✅ Successfully shortened with ${shortener.name}: ${shorturl}`);
                    return {
                        success: true,
                        shorturl,
                        originalUrl: longUrl,
                        service: shortener.name
                    };
                }

            } catch (error) {
                console.log(`❌ ${shortener.name} failed:`, error.response?.status || error.message);
                continue;
            }
        }
    }

    // All shorteners failed, return original URL
    console.warn('⚠️  All URL shortening services failed, returning original URL');
    return {
        success: false,
        shorturl: longUrl,
        originalUrl: longUrl,
        service: 'none',
        error: 'All shortening services failed'
    };
}

// Format discord message
function formatDiscordMessage(data) {
    const baseEmbed = {
        color: 0x5865F2,
        footer: { text: "YouTube Monitor Pro - Auto" },
        timestamp: new Date().toISOString()
    };

    switch (data.event) {
        case 'stream_started':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: `🔴 ${data.title || 'Live Now!'}`,
                    description: `${data.channelHandle} is now live on YouTube!\n\n[Watch Here](${data.shorturl})\n\n[Copy Link](${data.shorturl})`,
                    url: data.shorturl,
                    color: 0xFF0000,
                    thumbnail: {
                        url: data.thumbnail || `https://img.youtube.com/vi/${data.videoId}/default.jpg`
                    },
                    fields: [
                        {
                            name: "Channel",
                            value: `[${data.channelHandle}](${data.channelUrl})`,
                            inline: true
                        },
                        {
                            name: "Status",
                            value: "🔴 Live Now",
                            inline: true
                        },
                        {
                            name: "Short Link",
                            value: `[${data.shorturl.replace(/^https?:\/\//, '')}](${data.shorturl})`,
                            inline: true
                        }
                    ]
                }]
            };

        case 'stream_ended':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '📴 Stream Ended',
                    description: `${data.channelHandle}'s stream has ended.`,
                    color: 0x808080,
                    fields: [
                        {
                            name: "Channel",
                            value: `[${data.channelHandle}](${data.channelUrl})`,
                            inline: true
                        },
                        {
                            name: "Status",
                            value: "📴 Offline",
                            inline: true
                        }
                    ]
                }]
            };

        case 'new_video':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: `📹 New Video: ${data.title}`,
                    description: `${data.channelHandle} just uploaded a new video!\n\n[Watch Now](${data.shorturl})`,
                    url: data.shorturl,
                    color: 0x5865F2,
                    thumbnail: {
                        url: data.thumbnail || 'https://i.imgur.com/4M34hi2.png'
                    },
                    fields: [
                        {
                            name: "Channel",
                            value: `[${data.channelHandle}](${data.channelUrl})`,
                            inline: true
                        },
                        {
                            name: "Published",
                            value: data.publishedAt || 'Recently',
                            inline: true
                        },
                        {
                            name: "Views",
                            value: data.viewCount || 'N/A',
                            inline: true
                        },
                        {
                            name: "Short Link",
                            value: `[${data.shorturl.replace(/^https?:\/\//, '')}](${data.shorturl})`,
                            inline: true
                        }
                    ]
                }]
            };

        case 'new_short':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: `🎬 New Short: ${data.title}`,
                    description: `${data.channelHandle} just posted a new YouTube Short!\n\n[Watch Now](${data.shorturl})`,
                    url: data.shorturl,
                    color: 0xFF6B6B,
                    thumbnail: {
                        url: data.thumbnail || 'https://i.imgur.com/4M34hi2.png'
                    },
                    fields: [
                        {
                            name: "Channel",
                            value: `[${data.channelHandle}](${data.channelUrl})`,
                            inline: true
                        },
                        {
                            name: "Published",
                            value: data.publishedAt || 'Recently',
                            inline: true
                        },
                        {
                            name: "Views",
                            value: data.viewCount || 'N/A',
                            inline: true
                        },
                        {
                            name: "Short Link",
                            value: `[${data.shorturl.replace(/^https?:\/\//, '')}](${data.shorturl})`,
                            inline: true
                        }
                    ]
                }]
            };

        case 'monitoring_started':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '🚀 Monitoring Started',
                    description: `Auto-monitoring has been started for ${data.channelHandle}.\n\nYou'll receive notifications for: ${data.contentTypes.join(', ')}`,
                    color: 0x00FF00,
                    fields: [
                        {
                            name: "Channel",
                            value: `[${data.channelHandle}](${data.channelUrl})`,
                            inline: true
                        },
                        {
                            name: "Check Interval",
                            value: `${data.interval / 1000}s`,
                            inline: true
                        },
                        {
                            name: "Content Types",
                            value: data.contentTypes.join(', '),
                            inline: true
                        }
                    ]
                }]
            };

        case 'monitoring_error':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '⚠️ Monitoring Error',
                    description: `Monitoring for ${data.channelHandle} has been stopped due to consecutive errors.`,
                    color: 0xFFA500,
                    fields: [
                        {
                            name: 'Consecutive Errors',
                            value: `${data.consecutiveErrors || 0}`,
                            inline: true
                        },
                        {
                            name: 'Action Required',
                            value: 'Please restart monitoring manually',
                            inline: true
                        }
                    ]
                }]
            };

        case 'test':
            return {
                embeds: [{
                    ...baseEmbed,
                    title: '🧪 Test Webhook',
                    description: 'This is a test notification from the YouTube monitor system.',
                    color: 0x00FF00,
                    fields: [
                        {
                            name: "Status",
                            value: "✅ Webhook working correctly",
                            inline: true
                        }
                    ]
                }]
            };

        default:
            return {
                content: `📡 Event from ${data.channelHandle}: \`${data.event}\`\n${data.message || ''}`
            };
    }
}

// API Routes

// Enhanced main API endpoint - now supports different content types
app.get('/api/live-link', async (req, res) => {
    try {
        const channelInput = req.query.channel;
        const contentType = req.query.type || 'live';
        
        if (!channelInput) {
            return res.status(400).json({
                success: false,
                error: 'Channel parameter is required'
            });
        }

        // Extract channel handle from URL if provided
        let channelHandle = channelInput.trim();
        try {
            const url = new URL(channelInput.startsWith('http') ? channelInput : `https://${channelInput}`);
            if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube')) {
                const pathParts = url.pathname.split('/').filter(part => part);
                if (pathParts.length > 0) {
                    channelHandle = pathParts[0];
                }
            }
        } catch (e) {
            // Not a valid URL, assume it's a handle
        }

        // Ensure handle starts with @
        if (!channelHandle.startsWith('@')) {
            channelHandle = `@${channelHandle}`;
        }

        const now = Date.now();
        const cacheKey = `${channelHandle}_${contentType}`;
        
        // Check cache
        const cachedData = globalCache.get(cacheKey);
        if (cachedData && (now - cachedData.lastChecked) < CACHE_DURATION) {
            console.log(`📋 Returning cached data for ${channelHandle} (${contentType})`);
            return res.json({
                success: true,
                cached: true,
                ...cachedData,
                channel: channelHandle,
                channelUrl: `https://www.youtube.com/${channelHandle}`,
                lastChecked: new Date(cachedData.lastChecked).toISOString(),
                cacheExpiresIn: Math.max(0, CACHE_DURATION - (now - cachedData.lastChecked))
            });
        }

        console.log(`🔍 Checking ${contentType} for ${channelHandle}...`);
        let result = {};

        switch (contentType) {
            case 'live':
                const liveStatus = await checkIfChannelIsLive(channelHandle);
                if (liveStatus.isLive && liveStatus.liveUrl) {
                    const shortenerResult = await shortenUrl(liveStatus.liveUrl);
                    result = {
                        success: true,
                        isLive: true,
                        hasContent: true,
                        shorturl: shortenerResult.shorturl,
                        originalUrl: liveStatus.liveUrl,
                        title: liveStatus.title,
                        thumbnail: liveStatus.thumbnail,
                        shortenerService: shortenerResult.service,
                        method: liveStatus.method
                    };
                } else {
                    result = {
                        success: true,
                        isLive: false,
                        hasContent: false,
                        message: `${channelHandle} is not currently live`
                    };
                }
                break;

            case 'videos':
                const videoResult = await getLatestVideos(channelHandle, 8);
                if (videoResult.success && videoResult.videos.length > 0) {
                    // Shorten URLs for videos
                    for (let video of videoResult.videos) {
                        const shortenerResult = await shortenUrl(video.url);
                        video.shorturl = shortenerResult.shorturl;
                        video.shortenerService = shortenerResult.service;
                    }
                    result = {
                        success: true,
                        hasContent: true,
                        videos: videoResult.videos,
                        contentType: 'videos'
                    };
                } else {
                    result = {
                        success: true,
                        hasContent: false,
                        videos: [],
                        message: `No recent videos found for ${channelHandle}`
                    };
                }
                break;

            case 'shorts':
                const shortResult = await getLatestShorts(channelHandle, 10);
                if (shortResult.success && shortResult.shorts.length > 0) {
                    // Shorten URLs for shorts
                    for (let short of shortResult.shorts) {
                        const shortenerResult = await shortenUrl(short.url);
                        short.shorturl = shortenerResult.shorturl;
                        short.shortenerService = shortenerResult.service;
                    }
                    result = {
                        success: true,
                        hasContent: true,
                        shorts: shortResult.shorts,
                        contentType: 'shorts'
                    };
                } else {
                    result = {
                        success: true,
                        hasContent: false,
                        shorts: [],
                        message: `No recent shorts found for ${channelHandle}`
                    };
                }
                break;

            case 'all':
                // Get all content types
                const [liveResult, videosResult, shortsResult] = await Promise.all([
                    checkIfChannelIsLive(channelHandle),
                    getLatestVideos(channelHandle, 10),
                    getLatestShorts(channelHandle, 10)
                ]);

                result = {
                    success: true,
                    contentType: 'all'
                };

                // Process live stream
                if (liveResult.isLive && liveResult.liveUrl) {
                    const shortenerResult = await shortenUrl(liveResult.liveUrl);
                    result.isLive = true;
                    result.liveStream = {
                        title: liveResult.title,
                        url: liveResult.liveUrl,
                        shortUrl: shortenerResult.shorturl,
                        thumbnail: liveResult.thumbnail
                    };
                } else {
                    result.isLive = false;
                }

                // Process videos
                if (videosResult.success && videosResult.videos.length > 0) {
                    for (let video of videosResult.videos) {
                        const shortenerResult = await shortenUrl(video.url);
                        video.shorturl = shortenerResult.shorturl;
                        video.shortenerService = shortenerResult.service;
                    }
                    result.videos = videosResult.videos;
                } else {
                    result.videos = [];
                }

                // Process shorts
                if (shortsResult.success && shortsResult.shorts.length > 0) {
                    for (let short of shortsResult.shorts) {
                        const shortenerResult = await shortenUrl(short.url);
                        short.shorturl = shortenerResult.shorturl;
                        short.shortenerService = shortenerResult.service;
                    }
                    result.shorts = shortsResult.shorts;
                } else {
                    result.shorts = [];
                }

                result.hasContent = result.isLive || result.videos.length > 0 || result.shorts.length > 0;
                break;
        }

        // Update cache
        globalCache.set(cacheKey, {
            ...result,
            lastChecked: now
        });

        res.json({
            ...result,
            channel: channelHandle,
            channelUrl: `https://www.youtube.com/${channelHandle}`,
            lastChecked: new Date(now).toISOString()
        });

    } catch (error) {
        console.error('❌ API Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// NEW: Auto-setup monitoring endpoint (one-time setup)
app.post('/api/monitoring/setup', async (req, res) => {
    try {
        const { channel, webhook, interval, contentTypes } = req.body;
        
        if (!channel) {
            return res.status(400).json({
                success: false,
                error: 'Channel parameter is required'
            });
        }

        if (!webhook) {
            return res.status(400).json({
                success: false,
                error: 'Webhook URL is required'
            });
        }

        // Extract and normalize channel handle
        let channelHandle = channel.trim();
        try {
            const url = new URL(channel.startsWith('http') ? channel : `https://${channel}`);
            if (url.hostname.includes('youtube.com') || url.hostname.includes('youtube')) {
                const pathParts = url.pathname.split('/').filter(part => part);
                if (pathParts.length > 0) {
                    channelHandle = pathParts[0];
                }
            }
        } catch (e) {
            // Not a valid URL, assume it's a handle
        }

        // Ensure handle starts with @
        if (!channelHandle.startsWith('@')) {
            channelHandle = `@${channelHandle}`;
        }

        // Validate content types
        const validContentTypes = ['live', 'videos', 'shorts'];
        const selectedTypes = contentTypes && Array.isArray(contentTypes) 
            ? contentTypes.filter(type => validContentTypes.includes(type))
            : ['live', 'videos', 'shorts']; // Default to all types

        if (selectedTypes.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one valid content type must be specified'
            });
        }

        // Check if already monitoring this channel
        if (monitoringInstances.has(channelHandle)) {
            const existingInstance = monitoringInstances.get(channelHandle);
            if (existingInstance.isMonitoring) {
                // Update webhook URL and content types if different
                if (existingInstance.webhookUrl !== webhook || 
                    JSON.stringify(existingInstance.contentTypes.sort()) !== JSON.stringify(selectedTypes.sort())) {
                    
                    // Stop existing monitoring
                    existingInstance.stop();
                    
                    // Create new instance with updated config
                    const monitoringInterval = interval ? parseInt(interval) * 1000 : DEFAULT_MONITOR_INTERVAL;
                    const newInstance = new MonitoringInstance(channelHandle, webhook, monitoringInterval, selectedTypes);
                    
                    // Start new monitoring
                    const result = await newInstance.start();
                    
                    if (result.success) {
                        monitoringInstances.set(channelHandle, newInstance);
                        persistentChannels.set(channelHandle, {
                            channelHandle,
                            webhookUrl: webhook,
                            interval: monitoringInterval,
                            contentTypes: selectedTypes,
                            setupAt: Date.now()
                        });
                        
                        // Send setup confirmation webhook
                        await newInstance.sendWebhookNotification({
                            event: 'monitoring_started',
                            contentTypes: selectedTypes,
                            interval: monitoringInterval
                        });
                        
                        return res.json({
                            success: true,
                            message: `Updated and restarted monitoring for ${channelHandle}`,
                            config: {
                                channel: channelHandle,
                                interval: monitoringInterval / 1000,
                                contentTypes: selectedTypes,
                                webhookConfigured: true,
                                action: 'updated'
                            },
                            status: newInstance.getStatus()
                        });
                    }
                } else {
                    return res.json({
                        success: true,
                        message: `Already monitoring ${channelHandle} with same configuration`,
                        config: {
                            channel: channelHandle,
                            interval: existingInstance.interval / 1000,
                            contentTypes: existingInstance.contentTypes,
                            webhookConfigured: true,
                            action: 'existing'
                        },
                        status: existingInstance.getStatus()
                    });
                }
            }
        }

        // Create new monitoring instance
        const monitoringInterval = interval ? parseInt(interval) * 1000 : DEFAULT_MONITOR_INTERVAL;
        const instance = new MonitoringInstance(channelHandle, webhook, monitoringInterval, selectedTypes);
        
        // Start monitoring
        const result = await instance.start();
        
        if (result.success) {
            monitoringInstances.set(channelHandle, instance);
            persistentChannels.set(channelHandle, {
                channelHandle,
                webhookUrl: webhook,
                interval: monitoringInterval,
                contentTypes: selectedTypes,
                setupAt: Date.now()
            });
            
            // Send setup confirmation webhook
            await instance.sendWebhookNotification({
                event: 'monitoring_started',
                contentTypes: selectedTypes,
                interval: monitoringInterval
            });
            
            res.json({
                success: true,
                message: `Auto-monitoring setup complete for ${channelHandle}! You'll receive notifications for ${selectedTypes.join(', ')}.`,
                config: {
                    channel: channelHandle,
                    interval: monitoringInterval / 1000,
                    contentTypes: selectedTypes,
                    webhookConfigured: true,
                    action: 'created'
                },
                status: instance.getStatus()
            });
        } else {
            res.json({
                success: false,
                message: result.message,
                status: instance.getStatus()
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Enhanced start monitoring endpoint (backwards compatibility)
app.post('/api/monitoring/start', async (req, res) => {
    // Redirect to setup endpoint for consistency
    return app._router.handle(req, res, () => {
        req.url = '/api/monitoring/setup';
        app._router.handle(req, res);
    });
});

// Enhanced stop monitoring endpoint
app.post('/api/monitoring/stop', async (req, res) => {
    try {
        const { channel } = req.body;
        
        if (channel) {
            // Stop specific channel monitoring
            let channelHandle = channel.trim();
            if (!channelHandle.startsWith('@')) {
                channelHandle = `@${channelHandle}`;
            }
            
            const instance = monitoringInstances.get(channelHandle);
            if (!instance) {
                return res.json({
                    success: false,
                    message: `Not monitoring ${channelHandle}`
                });
            }
            
            const result = instance.stop();
            if (result.success) {
                monitoringInstances.delete(channelHandle);
                persistentChannels.delete(channelHandle);
                await saveMonitoringData(); // Remove from persistent storage
                
                // Send stop notification
                await instance.sendWebhookNotification({
                    event: 'monitoring_stopped',
                    message: 'Monitoring has been stopped manually'
                });
            }
            
            res.json({
                success: result.success,
                message: result.message,
                channel: channelHandle,
                status: instance.getStatus()
            });
        } else {
            // Stop all monitoring
            let stoppedCount = 0;
            const stoppedChannels = [];
            
            for (const [channelHandle, instance] of monitoringInstances) {
                if (instance.isMonitoring) {
                    instance.stop();
                    stoppedChannels.push(channelHandle);
                    stoppedCount++;
                    
                    // Send stop notification
                    await instance.sendWebhookNotification({
                        event: 'monitoring_stopped',
                        message: 'All monitoring has been stopped'
                    });
                }
            }
            
            monitoringInstances.clear();
            persistentChannels.clear();
            await saveMonitoringData(); // Clear persistent storage
            
            res.json({
                success: true,
                message: `Stopped monitoring ${stoppedCount} channels`,
                stoppedChannels: stoppedChannels,
                stoppedCount: stoppedCount
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get all saved channels endpoint
app.get('/api/monitoring/channels', async (req, res) => {
    try {
        const channels = [];
        
        for (const [channelHandle, config] of persistentChannels) {
            try {
                const instance = monitoringInstances.get(channelHandle);
                
                // Safely handle setupAt timestamp
                let setupAt;
                try {
                    setupAt = config.setupAt 
                        ? new Date(config.setupAt).toISOString() 
                        : new Date().toISOString();
                } catch (e) {
                    console.warn(`Invalid date for ${channelHandle}, using current time`);
                    setupAt = new Date().toISOString();
                }
                
                // Ensure contentTypes is always an array
                const contentTypes = Array.isArray(config.contentTypes) 
                    ? config.contentTypes 
                    : ['live']; // Default value
                
                channels.push({
                    channelHandle: config.channelHandle || channelHandle,
                    channelUrl: `https://www.youtube.com/${config.channelHandle || channelHandle}`,
                    webhookConfigured: !!config.webhookUrl,
                    contentTypes: contentTypes,
                    interval: config.interval ? config.interval / 1000 : DEFAULT_MONITOR_INTERVAL / 1000,
                    setupAt: setupAt,
                    isCurrentlyMonitoring: instance ? instance.isMonitoring : false,
                    status: instance ? instance.getStatus() : null
                });
            } catch (error) {
                console.error(`Error processing channel ${channelHandle}:`, error);
                // Continue with next channel
                continue;
            }
        }
        
        res.json({
            success: true,
            totalChannels: channels.length,
            activeChannels: channels.filter(c => c.isCurrentlyMonitoring).length,
            channels: channels
        });
    } catch (error) {
        console.error('Error in /api/monitoring/channels:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Monitoring status endpoint (enhanced)
app.get('/api/monitoring/status', (req, res) => {
    try {
        const { channel } = req.query;
        
        if (channel) {
            // Get status for specific channel
            let channelHandle = channel.trim();
            if (!channelHandle.startsWith('@')) {
                channelHandle = `@${channelHandle}`;
            }
            
            const instance = monitoringInstances.get(channelHandle);
            const persistentConfig = persistentChannels.get(channelHandle);
            
            if (!instance && !persistentConfig) {
                return res.json({
                    success: false,
                    message: `Channel ${channelHandle} is not configured for monitoring`
                });
            }
            
            res.json({
                success: true,
                monitoring: instance ? instance.getStatus() : null,
                persistent: persistentConfig || null,
                cache: globalCache.get(channelHandle) || null,
                isConfigured: !!persistentConfig,
                isActive: instance ? instance.isMonitoring : false
            });
        } else {
            // Get status for all monitored channels
            const allStatuses = [];
            for (const [channelHandle, instance] of monitoringInstances) {
                allStatuses.push({
                    ...instance.getStatus(),
                    cache: globalCache.get(channelHandle) || null,
                    persistent: persistentChannels.get(channelHandle) || null
                });
            }
            
            // Also include non-active but configured channels
            for (const [channelHandle, config] of persistentChannels) {
                if (!monitoringInstances.has(channelHandle)) {
                    allStatuses.push({
                        channelHandle: config.channelHandle,
                        channelUrl: `https://www.youtube.com/${config.channelHandle}`,
                        webhookUrl: config.webhookUrl ? config.webhookUrl.replace(/\/[^\/]*$/, '/***') : null,
                        isMonitoring: false,
                        contentTypes: config.contentTypes,
                        interval: config.interval,
                        setupAt: new Date(config.setupAt).toISOString(),
                        persistent: config,
                        cache: null,
                        status: 'configured_but_stopped'
                    });
                }
            }
            
            res.json({
                success: true,
                totalChannels: allStatuses.length,
                activeChannels: allStatuses.filter(s => s.isMonitoring).length,
                configuredChannels: persistentChannels.size,
                monitoring: allStatuses,
                serverUptime: Math.floor(process.uptime())
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test webhook endpoint
app.post('/api/monitoring/test-webhook', async (req, res) => {
    try {
        const { webhook, channel } = req.body;
        
        if (!webhook) {
            return res.status(400).json({
                success: false,
                error: 'Webhook URL is required'
            });
        }

        const testChannel = channel || '@testchannel';
        
        // Create temporary instance for testing
        const tempInstance = new MonitoringInstance(testChannel, webhook);
        
        const success = await tempInstance.sendWebhookNotification({
            event: 'test',
            message: 'This is a test webhook notification',
            timestamp: new Date().toISOString()
        });

        res.json({
            success: success,
            message: success ? 'Test webhook sent successfully' : 'Test webhook failed',
            webhookUrl: webhook.replace(/\/[^\/]*$/, '/***'),
            testChannel: testChannel
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Restart specific channel monitoring endpoint
app.post('/api/monitoring/restart', async (req, res) => {
    try {
        const { channel } = req.body;
        
        if (!channel) {
            return res.status(400).json({
                success: false,
                error: 'Channel parameter is required'
            });
        }

        let channelHandle = channel.trim();
        if (!channelHandle.startsWith('@')) {
            channelHandle = `@${channelHandle}`;
        }

        const persistentConfig = persistentChannels.get(channelHandle);
        if (!persistentConfig) {
            return res.json({
                success: false,
                message: `No saved configuration found for ${channelHandle}. Please setup monitoring first.`
            });
        }

        // Stop existing monitoring if running
        const existingInstance = monitoringInstances.get(channelHandle);
        if (existingInstance && existingInstance.isMonitoring) {
            existingInstance.stop();
        }

        // Create new instance from saved config
        const instance = new MonitoringInstance(
            persistentConfig.channelHandle,
            persistentConfig.webhookUrl,
            persistentConfig.interval,
            persistentConfig.contentTypes
        );

        // Start monitoring
        const result = await instance.start();
        
        if (result.success) {
            monitoringInstances.set(channelHandle, instance);
            
            res.json({
                success: true,
                message: `Restarted monitoring for ${channelHandle}`,
                config: {
                    channel: channelHandle,
                    interval: persistentConfig.interval / 1000,
                    contentTypes: persistentConfig.contentTypes,
                    webhookConfigured: true
                },
                status: instance.getStatus()
            });
        } else {
            res.json({
                success: false,
                message: result.message
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint (enhanced)
app.get('/health', (req, res) => {
    const activeChannels = Array.from(monitoringInstances.values()).filter(i => i.isMonitoring);
    
    res.json({
        status: 'OK',
        service: 'YouTube Monitor Pro API',
        version: '2.2.0',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        monitoring: {
            totalChannels: monitoringInstances.size,
            activeChannels: activeChannels.length,
            configuredChannels: persistentChannels.size,
            channels: activeChannels.map(i => ({
                handle: i.channelHandle,
                contentTypes: i.contentTypes,
                uptime: i.startedAt ? Math.floor((Date.now() - i.startedAt) / 1000) : 0
            }))
        },
        cache: {
            totalEntries: globalCache.size,
            channels: Array.from(globalCache.keys())
        },
        persistence: {
            dataFile: DATA_FILE,
            autoSaveEnabled: true,
            lastSaved: 'Auto-saved every 5 minutes'
        }
    });
});

// API info endpoint (enhanced)
app.get('/api/info', (req, res) => {
    res.json({
        success: true,
        service: {
            name: 'YouTube Monitor Pro',
            version: '2.2.0',
            description: 'Enhanced YouTube channel monitoring with persistent auto-monitoring'
        },
        features: [
            'Persistent monitoring (survives server restarts)',
            'One-time setup with automatic notifications',
            'Live stream monitoring',
            'Latest videos tracking',
            'YouTube Shorts monitoring',
            'Multi-content type support',
            'URL shortening with multiple services',
            'Discord webhook notifications',
            'Response caching',
            'Fallback detection methods',
            'Multi-channel support',
            'Real-time status monitoring',
            'Enhanced error handling',
            'Auto-save monitoring configurations'
        ],
        endpoints: {
            'GET /api/live-link?channel=@channelname&type=live': 'Get live stream status and short URL',
            'GET /api/live-link?channel=@channelname&type=videos': 'Get latest videos',
            'GET /api/live-link?channel=@channelname&type=shorts': 'Get latest shorts',
            'GET /api/live-link?channel=@channelname&type=all': 'Get all content types',
            'POST /api/monitoring/setup': 'One-time setup for persistent monitoring',
            'POST /api/monitoring/start': 'Start monitoring (alias for setup)',
            'POST /api/monitoring/stop': 'Stop monitoring',
            'POST /api/monitoring/restart': 'Restart monitoring from saved config',
            'GET /api/monitoring/status': 'Get monitoring status',
            'GET /api/monitoring/channels': 'Get all configured channels',
            'POST /api/monitoring/test-webhook': 'Test webhook notification',
            'GET /health': 'Health check and system status',
            'GET /api/info': 'API information and documentation'
        },
        contentTypes: {
            'live': 'Live streams and ongoing broadcasts',
            'videos': 'Latest uploaded videos (excluding shorts)',
            'shorts': 'Latest YouTube Shorts',
            'all': 'All content types combined'
        },
        configuration: {
            youtubeApiSupported: !!process.env.YOUTUBE_API_KEY,
            linktwApiSupported: !!process.env.LINKTW_API_KEY,
            cacheDuration: CACHE_DURATION / 1000,
            defaultMonitorInterval: DEFAULT_MONITOR_INTERVAL / 1000,
            persistentStorage: true,
            autoSaveInterval: 300 // 5 minutes
        }
    });
});

// Manual refresh endpoint
app.post('/api/refresh', async (req, res) => {
    try {
        const { channel, type } = req.body;
        
        if (!channel) {
            return res.status(400).json({
                success: false,
                error: 'Channel parameter is required'
            });
        }

        let channelHandle = channel.trim();
        if (!channelHandle.startsWith('@')) {
            channelHandle = `@${channelHandle}`;
        }

        const contentType = type || 'live';
        const cacheKey = `${channelHandle}_${contentType}`;

        console.log(`🔄 Manual refresh requested for ${channelHandle} (${contentType}) - clearing cache...`);
        
        // Clear cache for this channel and content type
        globalCache.delete(cacheKey);

        // Make a fresh request to the main API endpoint
        const protocol = req.secure ? 'https' : 'http';
        const host = req.get('host');
        const apiUrl = `${protocol}://${host}/api/live-link?channel=${encodeURIComponent(channelHandle)}&type=${contentType}`;
        
        try {
            const response = await axios.get(apiUrl);
            const data = response.data;
            
            res.json({
                success: true,
                message: `Cache refreshed for ${channelHandle} (${contentType})`,
                ...data
            });
        } catch (apiError) {
            // Fallback: manually call the function
            console.log('Internal API call failed, using direct function call');
            
            let result = {};
            switch (contentType) {
                case 'live':
                    const liveStatus = await checkIfChannelIsLive(channelHandle);
                    if (liveStatus.isLive && liveStatus.liveUrl) {
                        const shortenerResult = await shortenUrl(liveStatus.liveUrl);
                        result = {
                            success: true,
                            isLive: true,
                            hasContent: true,
                            shorturl: shortenerResult.shorturl,
                            originalUrl: liveStatus.liveUrl,
                            title: liveStatus.title,
                            thumbnail: liveStatus.thumbnail,
                            shortenerService: shortenerResult.service,
                            method: liveStatus.method
                        };
                    } else {
                        result = {
                            success: true,
                            isLive: false,
                            hasContent: false,
                            message: `${channelHandle} is not currently live`
                        };
                    }
                    break;
                case 'videos':
                    const videoResult = await getLatestVideos(channelHandle, 10);
                    result = {
                        success: videoResult.success,
                        hasContent: videoResult.success && videoResult.videos.length > 0,
                        videos: videoResult.videos || [],
                        contentType: 'videos'
                    };
                    break;
                case 'shorts':
                    const shortResult = await getLatestShorts(channelHandle, 10);
                    result = {
                        success: shortResult.success,
                        hasContent: shortResult.success && shortResult.shorts.length > 0,
                        shorts: shortResult.shorts || [],
                        contentType: 'shorts'
                    };
                    break;
            }
            
            res.json({
                success: true,
                message: `Cache refreshed for ${channelHandle} (${contentType})`,
                channel: channelHandle,
                channelUrl: `https://www.youtube.com/${channelHandle}`,
                lastChecked: new Date().toISOString(),
                ...result
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Initialize server with auto-load
async function initializeServer() {
    console.log('🔄 Initializing YouTube Monitor Pro...');
    
    // Load saved monitoring configurations
    await loadMonitoringData();
    
    // Start the server
    app.listen(PORT, () => {
        console.log('🚀 YouTube Monitor Pro API Started!');
        console.log('─'.repeat(80));
        console.log(`📍 Server: http://localhost:${PORT}`);
        console.log(`🔗 API: http://localhost:${PORT}/api/live-link?channel=@channelname&type=live`);
        console.log(`💚 Health: http://localhost:${PORT}/health`);
        console.log(`📊 API Info: http://localhost:${PORT}/api/info`);
        console.log(`🔍 Monitoring: http://localhost:${PORT}/api/monitoring/status`);
        console.log(`⚙️  Setup: http://localhost:${PORT}/api/monitoring/setup`);
        console.log('─'.repeat(80));
        console.log('🔧 Configuration:');
        console.log(`   YouTube API: ${process.env.YOUTUBE_API_KEY ? '✅ Configured' : '⚠️  Using fallback'}`);
        console.log(`   Linktw API: ${process.env.LINKTW_API_KEY ? '✅ Configured' : '⚠️  Not configured'}`);
        console.log(`   Cache Duration: ${CACHE_DURATION / 1000}s`);
        console.log(`   Default Monitor Interval: ${DEFAULT_MONITOR_INTERVAL / 1000}s`);
        console.log(`   Persistent Storage: ✅ Enabled`);
        console.log(`   Auto-Save Interval: 5 minutes`);
        console.log('─'.repeat(80));
        console.log('🎯 Enhanced Features:');
        console.log('   ✅ Persistent monitoring (survives restarts)');
        console.log('   ✅ One-time setup with auto-notifications');
        console.log('   ✅ Live stream monitoring');
        console.log('   ✅ Latest videos tracking');
        console.log('   ✅ YouTube Shorts support');
        console.log('   ✅ Multi-content type monitoring');
        console.log('   ✅ Enhanced webhook notifications');
        console.log('   ✅ Improved error handling');
        console.log('   ✅ Better caching system');
        console.log('   ✅ Auto-resume monitoring');
        console.log('─'.repeat(80));
        
        const activeMonitors = Array.from(monitoringInstances.values()).filter(i => i.isMonitoring);
        console.log(`📡 Monitoring Status:`);
        console.log(`   Active Channels: ${activeMonitors.length}`);
        console.log(`   Configured Channels: ${persistentChannels.size}`);
        
        if (activeMonitors.length > 0) {
            console.log(`   Monitored Channels:`);
            activeMonitors.forEach(instance => {
                console.log(`     - ${instance.channelHandle} (${instance.contentTypes.join(', ')})`);
            });
        }
        
        console.log('─'.repeat(80));
        console.log('Ready for persistent auto-monitoring! 🎬📹🎭');
        console.log('💡 Use the setup endpoint to configure one-time auto-monitoring');
    });
}

// Graceful shutdown with data saving
async function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} received, shutting down gracefully...`);
    
    // Save monitoring data before shutdown
    await saveMonitoringData();
    
    // Stop all monitoring instances
    for (const instance of monitoringInstances.values()) {
        instance.stop();
    }
    
    console.log('✅ Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Auto-save on uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);
    await saveMonitoringData();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    await saveMonitoringData();
});

// Initialize the server
initializeServer().catch(error => {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
});

module.exports = app;
