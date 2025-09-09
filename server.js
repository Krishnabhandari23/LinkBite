
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const {
    saveChannelConfiguration,
    updateChannelStates,
    removeChannelFromDatabase
} = require('./database');

// Add database functions
const {
    saveMonitoringData,
    loadMonitoringData,
    logMonitoringEvent,
    getAllChannelsFromDatabase,
    testDatabaseConnection
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration constants
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION) || 2 * 60 * 1000; // 2 minutes
const DEFAULT_MONITOR_INTERVAL = parseInt(process.env.DEFAULT_MONITOR_INTERVAL) || 60 * 1000; // 1 minute

// Dynamic monitoring state - supports multiple channels
let monitoringInstances = new Map(); // channelHandle -> monitoring instance
let globalCache = new Map(); // channelHandle -> cached data
let persistentChannels = new Map(); // channelHandle -> config data

// Monitoring instance structure (enhanced)
class MonitoringInstance {
    constructor(channelHandle, webhookUrl, interval = DEFAULT_MONITOR_INTERVAL, contentTypes = ['live']) {
        this.channelHandle = channelHandle;
        this.channelUrl = `https://www.youtube.com/${channelHandle}`;
        this.webhookUrl = webhookUrl;
        this.interval = interval;
        this.contentTypes = contentTypes;
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

        // Set up interval with arrow function to preserve 'this' context
        this.intervalId = setInterval(async () => {
            await this.checkContent();
        }, this.interval);

        // Save to database
        await this.saveToDatabase();

        return { success: true, message: 'Monitoring started successfully' };
    }

    async checkContent() {
        try {
            console.log(`🔍 Checking content for ${this.channelHandle}...`);

            for (const contentType of this.contentTypes) {
                await this.checkContentType(contentType);
            }

            this.consecutiveErrors = 0;
            this.lastChecked = Date.now();
        } catch (error) {
            console.error(`❌ Monitoring error for ${this.channelHandle}:`, error.message);
            this.consecutiveErrors++;

            if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                console.error(`❌ Too many consecutive errors for ${this.channelHandle}, stopping monitoring`);
                await this.stop();

                await this.sendWebhookNotification({
                    event: 'monitoring_error',
                    error: 'Monitoring stopped due to consecutive errors',
                    consecutiveErrors: this.consecutiveErrors
                });

                monitoringInstances.delete(this.channelHandle);
                persistentChannels.delete(this.channelHandle);
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

    // ✅ MISSING METHOD 1: saveToDatabase
    async saveToDatabase() {
        try {
            console.log(`💾 Saving ${this.channelHandle} to database...`);
            
            const result = await saveChannelConfiguration(this.channelHandle, {
                webhookUrl: this.webhookUrl,
                interval: this.interval,
                contentTypes: this.contentTypes,
                lastKnownStates: this.lastKnownStates
            });
            
            if (result.success) {
                console.log(`✅ Saved ${this.channelHandle} to database`);
                return { success: true };
            } else {
                console.error(`❌ Failed to save ${this.channelHandle} to database:`, result.error);
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error(`❌ Exception saving ${this.channelHandle}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    // ✅ MISSING METHOD 2: updateStatesInDatabase
    async updateStatesInDatabase() {
        try {
            const result = await updateChannelStates(this.channelHandle, this.lastKnownStates);
            if (!result.success) {
                console.error(`⚠️ Failed to update states for ${this.channelHandle}:`, result.error);
            } else {
                console.log(`✅ Updated states for ${this.channelHandle} in database`);
            }
            return result;
        } catch (error) {
            console.error(`❌ Exception updating states for ${this.channelHandle}:`, error.message);
            return { success: false, error: error.message };
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
            
            // ✅ Save state changes to database
            await this.updateStatesInDatabase();
        }
    }

    async handleNewVideo(videoResult) {
        if (videoResult.success && videoResult.videos.length > 0) {
            const latestVideo = videoResult.videos[0];

            if (this.lastKnownStates.latestVideoId !== latestVideo.videoId) {
                console.log(`📹 New video detected for ${this.channelHandle}: ${latestVideo.title}`);

                const shortenerResult = await shortenUrl(latestVideo.url);

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
                
                // ✅ Save state changes to database
                await this.updateStatesInDatabase();
            }
        }
    }

    async handleNewShort(shortResult) {
        if (shortResult.success && shortResult.shorts.length > 0) {
            const latestShort = shortResult.shorts[0];

            if (this.lastKnownStates.latestShortId !== latestShort.videoId) {
                console.log(`🎬 New short detected for ${this.channelHandle}: ${latestShort.title}`);

                const shortenerResult = await shortenUrl(latestShort.url);

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
                
                // ✅ Save state changes to database
                await this.updateStatesInDatabase();
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

    async stop() {
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

        // Remove from persistent channels and database
        persistentChannels.delete(this.channelHandle);
        await removeChannelFromDatabase(this.channelHandle);

        return { success: true, message: 'Monitoring stopped successfully' };
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

// Auto-setup monitoring endpoint (one-time setup)

// CRITICAL FIX: Replace your /api/monitoring/setup endpoint with this version

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
        const existingInstance = monitoringInstances.get(channelHandle);
        if (existingInstance && existingInstance.isMonitoring) {
            // Update webhook URL and content types if different
            if (existingInstance.webhookUrl !== webhook || 
                JSON.stringify(existingInstance.contentTypes.sort()) !== JSON.stringify(selectedTypes.sort())) {

                // Stop existing monitoring
                await existingInstance.stop();

                // Create new instance with updated config
                const monitoringInterval = interval ? parseInt(interval) * 1000 : DEFAULT_MONITOR_INTERVAL;
                const newInstance = new MonitoringInstance(channelHandle, webhook, monitoringInterval, selectedTypes);

                // Start new monitoring (this will save to database)
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

                    console.log(`✅ Updated and restarted monitoring for ${channelHandle}`);

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
                } else {
                    return res.json({
                        success: false,
                        message: result.message
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

        // Create new monitoring instance
        const monitoringInterval = interval ? parseInt(interval) * 1000 : DEFAULT_MONITOR_INTERVAL;
        const instance = new MonitoringInstance(channelHandle, webhook, monitoringInterval, selectedTypes);

        // Start monitoring (this will automatically save to database)
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

            console.log(`✅ Setup complete for ${channelHandle} - saved to database`);

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
        console.error('❌ Setup monitoring error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

//monitoring 
// ============================================================
// MONITORING API ENDPOINTS - Add these to your server.js
// ============================================================

// GET /api/monitoring/channels - Get all monitored channels
app.get('/api/monitoring/channels', async (req, res) => {
    try {
        console.log('📋 Getting all monitored channels...');
        
        // Get channels from database
        const dbResult = await getAllChannelsFromDatabase();
        
        if (!dbResult.success) {
            console.error('❌ Failed to get channels from database:', dbResult.error);
            return res.json({
                success: false,
                error: 'Failed to load channels from database',
                channels: [],
                totalChannels: 0,
                activeChannels: 0
            });
        }

        const channels = dbResult.channels || [];
        let formattedChannels = [];
        let activeChannels = 0;

        // Format channels with current monitoring status
        channels.forEach(dbChannel => {
            const instance = monitoringInstances.get(dbChannel.channel_handle);
            const isCurrentlyMonitoring = instance && instance.isMonitoring;
            
            if (isCurrentlyMonitoring) {
                activeChannels++;
            }

            const channel = {
                channelHandle: dbChannel.channel_handle,
                channelUrl: `https://www.youtube.com/${dbChannel.channel_handle}`,
                webhookUrl: dbChannel.webhook_url,
                contentTypes: dbChannel.content_types || [],
                interval: Math.floor(dbChannel.monitor_interval / 1000), // Convert to seconds
                setupAt: dbChannel.created_at,
                webhookConfigured: !!dbChannel.webhook_url,
                isCurrentlyMonitoring: isCurrentlyMonitoring,
                status: instance ? instance.getStatus() : null
            };

            formattedChannels.push(channel);
        });

        console.log(`✅ Retrieved ${channels.length} channels (${activeChannels} active)`);

        res.json({
            success: true,
            channels: formattedChannels,
            totalChannels: channels.length,
            activeChannels: activeChannels,
            configuredChannels: formattedChannels.filter(c => c.webhookConfigured).length
        });

    } catch (error) {
        console.error('❌ Error getting monitored channels:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            channels: [],
            totalChannels: 0,
            activeChannels: 0
        });
    }
});

// GET /api/monitoring/status - Get monitoring system status
app.get('/api/monitoring/status', (req, res) => {
    try {
        console.log('📊 Getting monitoring status...');
        
        const activeInstances = Array.from(monitoringInstances.values()).filter(i => i.isMonitoring);
        const totalChannels = persistentChannels.size;
        const serverUptimeSeconds = Math.floor(process.uptime());
        
        const monitoring = Array.from(monitoringInstances.values()).map(instance => {
            const status = instance.getStatus();
            return {
                channelHandle: status.channelHandle,
                channelUrl: status.channelUrl,
                isMonitoring: status.isMonitoring,
                contentTypes: status.contentTypes,
                interval: status.interval,
                webhookUrl: status.webhookUrl ? 'configured' : null,
                lastChecked: status.lastChecked,
                uptime: status.uptime,
                consecutiveErrors: status.consecutiveErrors,
                lastKnownLiveStatus: status.lastKnownLiveStatus,
                cache: globalCache.get(status.channelHandle)
            };
        });

        res.json({
            success: true,
            totalChannels: totalChannels,
            activeChannels: activeInstances.length,
            configuredChannels: Array.from(persistentChannels.values()).filter(c => c.webhookUrl).length,
            serverUptime: serverUptimeSeconds,
            monitoring: monitoring
        });

    } catch (error) {
        console.error('❌ Error getting monitoring status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/monitoring/setup - Setup monitoring for a channel
app.post('/api/monitoring/setup', async (req, res) => {
    try {
        const { channel, webhook, interval, contentTypes } = req.body;
        
        console.log(`📝 Setup request received:`, { 
            channel, 
            webhook: webhook ? 'PROVIDED' : 'MISSING', 
            contentTypes 
        });
        
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

        console.log(`📋 Normalized channel handle: ${channelHandle}`);

        // Validate content types
        const validContentTypes = ['live', 'videos', 'shorts'];
        const selectedTypes = contentTypes && Array.isArray(contentTypes) 
            ? contentTypes.filter(type => validContentTypes.includes(type))
            : ['live', 'videos', 'shorts'];

        if (selectedTypes.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one valid content type must be specified'
            });
        }

        const monitoringInterval = interval ? parseInt(interval) * 1000 : DEFAULT_MONITOR_INTERVAL;
        
        console.log(`⚙️ Configuration: interval=${monitoringInterval}ms, types=${selectedTypes.join(',')}`);

        // Check if already monitoring this channel
        const existingInstance = monitoringInstances.get(channelHandle);
        if (existingInstance && existingInstance.isMonitoring) {
            console.log(`⚠️ Channel ${channelHandle} is already being monitored`);
            
            return res.json({
                success: true,
                message: `Already monitoring ${channelHandle}`,
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

        console.log(`🆕 Creating new monitoring instance for ${channelHandle}`);
        
        // Create new monitoring instance
        const instance = new MonitoringInstance(channelHandle, webhook, monitoringInterval, selectedTypes);
        
        // Start monitoring
        const result = await instance.start();
        
        if (result.success) {
            console.log(`✅ Monitoring started successfully for ${channelHandle}`);
            
            monitoringInstances.set(channelHandle, instance);
            persistentChannels.set(channelHandle, {
                channelHandle,
                webhookUrl: webhook,
                interval: monitoringInterval,
                contentTypes: selectedTypes,
                setupAt: Date.now()
            });
            
            res.json({
                success: true,
                message: `Auto-monitoring setup complete for ${channelHandle}!`,
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
            console.error(`❌ Failed to start monitoring for ${channelHandle}:`, result.message);
            res.json({
                success: false,
                message: result.message
            });
        }
    } catch (error) {
        console.error('❌ Setup monitoring error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/monitoring/stop - Stop monitoring a channel
app.post('/api/monitoring/stop', async (req, res) => {
    try {
        const { channel } = req.body;
        
        if (!channel) {
            return res.status(400).json({
                success: false,
                message: 'Channel parameter is required'
            });
        }

        console.log(`🛑 Stopping monitoring for ${channel}...`);

        const instance = monitoringInstances.get(channel);
        
        if (!instance) {
            return res.json({
                success: true,
                message: `Channel ${channel} was not being monitored`
            });
        }

        const result = await instance.stop();
        
        if (result.success) {
            monitoringInstances.delete(channel);
            persistentChannels.delete(channel);
            
            console.log(`✅ Stopped monitoring for ${channel}`);
            
            res.json({
                success: true,
                message: `Stopped monitoring for ${channel}`
            });
        } else {
            res.json({
                success: false,
                message: result.message
            });
        }

    } catch (error) {
        console.error('❌ Stop monitoring error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/monitoring/restart - Restart monitoring for a channel
app.post('/api/monitoring/restart', async (req, res) => {
    try {
        const { channel } = req.body;
        
        if (!channel) {
            return res.status(400).json({
                success: false,
                message: 'Channel parameter is required'
            });
        }

        console.log(`🔄 Restarting monitoring for ${channel}...`);

        // Stop existing instance if running
        const existingInstance = monitoringInstances.get(channel);
        if (existingInstance) {
            await existingInstance.stop();
        }

        // Get channel config from persistent storage or database
        let channelConfig = persistentChannels.get(channel);
        
        if (!channelConfig) {
            // Try to get from database
            const dbResult = await getAllChannelsFromDatabase();
            if (dbResult.success) {
                const dbChannel = dbResult.channels.find(c => c.channel_handle === channel);
                if (dbChannel) {
                    channelConfig = {
                        channelHandle: dbChannel.channel_handle,
                        webhookUrl: dbChannel.webhook_url,
                        interval: dbChannel.monitor_interval,
                        contentTypes: dbChannel.content_types,
                        setupAt: dbChannel.created_at
                    };
                }
            }
        }

        if (!channelConfig) {
            return res.json({
                success: false,
                message: `No configuration found for ${channel}. Please set up monitoring first.`
            });
        }

        // Create new instance
        const instance = new MonitoringInstance(
            channelConfig.channelHandle,
            channelConfig.webhookUrl,
            channelConfig.interval,
            channelConfig.contentTypes
        );

        const result = await instance.start();
        
        if (result.success) {
            monitoringInstances.set(channel, instance);
            
            console.log(`✅ Restarted monitoring for ${channel}`);
            
            res.json({
                success: true,
                message: `Restarted monitoring for ${channel}`
            });
        } else {
            res.json({
                success: false,
                message: result.message
            });
        }

    } catch (error) {
        console.error('❌ Restart monitoring error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/monitoring/test-webhook - Test webhook
app.post('/api/monitoring/test-webhook', async (req, res) => {
    try {
        const { webhook, channel } = req.body;
        
        if (!webhook) {
            return res.status(400).json({
                success: false,
                error: 'Webhook URL is required'
            });
        }

        console.log(`🧪 Testing webhook for ${channel || 'test'}...`);

        const testPayload = formatDiscordMessage({
            event: 'webhook_test',
            channelHandle: channel || '@test-channel',
            channelUrl: `https://www.youtube.com/${channel || '@test-channel'}`,
            message: `🧪 Test webhook from LinkBite Monitor\n\nThis is a test notification to verify your Discord webhook is working correctly.\n\nTime: ${new Date().toLocaleString()}`
        });

        const response = await axios.post(webhook, testPayload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'LinkBite-Monitor-Test/1.0'
            }
        });

        if (response.status >= 200 && response.status < 300) {
            console.log(`✅ Test webhook sent successfully`);
            res.json({
                success: true,
                message: 'Test webhook sent successfully!'
            });
        } else {
            console.error(`❌ Webhook test failed with status:`, response.status);
            res.json({
                success: false,
                error: `Webhook returned status ${response.status}`
            });
        }

    } catch (error) {
        console.error('❌ Test webhook error:', error);
        
        let errorMessage = 'Webhook test failed';
        if (error.code === 'ECONNREFUSED') {
            errorMessage = 'Connection refused - check webhook URL';
        } else if (error.code === 'ENOTFOUND') {
            errorMessage = 'Invalid webhook URL';
        } else if (error.response) {
            errorMessage = `Webhook error: ${error.response.status} ${error.response.statusText}`;
        } else {
            errorMessage = error.message;
        }

        res.status(500).json({
            success: false,
            error: errorMessage
        });
    }
});


// CRITICAL FIX: Also update the initialization to load from database
async function initializeServer() {
    console.log('🔄 Initializing YouTube Monitor Pro with Database...');

    // Test database connection first
    console.log('🔍 Testing database connection...');
    const dbTest = await testDatabaseConnection();
    if (!dbTest.success) {
        console.error('❌ Database connection failed. Please check your Supabase configuration.');
        console.error('Make sure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set correctly.');
        console.error('Also run the SQL setup script in Supabase.');
        console.error('Error details:', dbTest.error);
        // Don't exit - allow server to run without database
        console.log('⚠️ Continuing without database - monitoring will not persist');
    } else {
        console.log('✅ Database connection successful');

        // Load saved monitoring configurations from database
        console.log('📂 Loading monitoring configurations from database...');
        const loadResult = await loadMonitoringData();
        if (loadResult.success && loadResult.channels && loadResult.channels.length > 0) {
            console.log(`📊 Found ${loadResult.channels.length} saved configurations`);

            // Restore monitoring instances from database
            for (const channelConfig of loadResult.channels) {
                try {
                    console.log(`🔄 Restoring monitoring for ${channelConfig.channelHandle}...`);

                    const instance = new MonitoringInstance(
                        channelConfig.channelHandle,
                        channelConfig.webhookUrl,
                        channelConfig.interval,
                        channelConfig.contentTypes
                    );

                    // Restore last known states
                    if (channelConfig.lastKnownStates) {
                        instance.lastKnownStates = channelConfig.lastKnownStates;
                    }

                    // Start monitoring (this will NOT re-save to database since it already exists)
                    const result = await instance.start();
                    if (result.success) {
                        monitoringInstances.set(channelConfig.channelHandle, instance);
                        persistentChannels.set(channelConfig.channelHandle, {
                            channelHandle: channelConfig.channelHandle,
                            webhookUrl: channelConfig.webhookUrl,
                            interval: channelConfig.interval,
                            contentTypes: channelConfig.contentTypes,
                            setupAt: channelConfig.setupAt
                        });

                        console.log(`✅ Restored monitoring for ${channelConfig.channelHandle}`);
                    } else {
                        console.error(`❌ Failed to restore monitoring for ${channelConfig.channelHandle}:`, result.message);
                    }
                } catch (error) {
                    console.error(`❌ Error restoring ${channelConfig.channelHandle}:`, error.message);
                }
            }

            console.log(`✅ Successfully restored ${monitoringInstances.size} monitoring instances`);
        } else if (loadResult.error) {
            console.error('❌ Failed to load monitoring data:', loadResult.error);
        } else {
            console.log('📋 No existing monitoring configurations found');
        }
    }

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
        console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅ Connected' : '❌ Not configured'}`);
        console.log(`   Linktw API: ${process.env.LINKTW_API_KEY ? '✅ Configured' : '⚠️  Not configured'}`);
        console.log(`   Cache Duration: ${CACHE_DURATION / 1000}s`);
        console.log(`   Default Monitor Interval: ${DEFAULT_MONITOR_INTERVAL / 1000}s`);
        console.log(`   Persistent Storage: ✅ Database (Supabase)`);
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
        console.log('Ready for persistent database monitoring! 🎬📹🎭');
        console.log('💡 Use the setup endpoint to configure one-time auto-monitoring');
    });
}

// Replace your initializeServer() call with:
initializeServer().catch(error => {
    console.error('❌ Failed to initialize server:', error);
    process.exit(1);
});

module.exports = app;


