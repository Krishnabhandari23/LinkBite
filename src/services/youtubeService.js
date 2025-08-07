import axios from 'axios';
import config from '../config/config.js';

class YouTubeService {
    constructor() {
        this.apiKey = config.youtubeApiKey;
        this.channelHandle = config.channel.handle;
        this.baseUrl = config.apis.youtube;
    }

    // Extract channel ID from handle
    async getChannelIdFromHandle(handle) {
        try {
            const cleanHandle = handle.replace('@', '');
            
            // Try multiple approaches to get channel ID
            const searchResponse = await axios.get(`${this.baseUrl}/search`, {
                params: {
                    part: 'snippet',
                    q: cleanHandle,
                    type: 'channel',
                    key: this.apiKey,
                    maxResults: 1
                }
            });

            if (searchResponse.data.items && searchResponse.data.items.length > 0) {
                return searchResponse.data.items[0].id.channelId;
            }

            throw new Error('Channel not found');
        } catch (error) {
            console.error('Error getting channel ID:', error.message);
            
            // Fallback: try to scrape from YouTube page
            try {
                const response = await axios.get(`https://www.youtube.com/${handle}`);
                const html = response.data;
                
                const channelIdMatch = html.match(/"channelId":"([^"]+)"/);
                if (channelIdMatch) {
                    return channelIdMatch[1];
                }
                
                const altMatch = html.match(/channel\/([a-zA-Z0-9_-]{24})/);
                if (altMatch) {
                    return altMatch[1];
                }
            } catch (scrapeError) {
                console.error('Scraping fallback failed:', scrapeError.message);
            }
            
            throw error;
        }
    }

    // Check if channel is currently live
    async checkIfChannelIsLive() {
        try {
            if (!this.apiKey) {
                console.warn('YouTube API key not configured, using fallback method');
                return await this.checkLiveStatusViaRSS();
            }

            // Get channel ID first
            const channelId = await this.getChannelIdFromHandle(this.channelHandle);
            
            // Search for live streams from this channel
            const searchResponse = await axios.get(`${this.baseUrl}/search`, {
                params: {
                    part: 'snippet',
                    channelId: channelId,
                    eventType: 'live',
                    type: 'video',
                    key: this.apiKey,
                    maxResults: 1
                }
            });

            if (searchResponse.data.items && searchResponse.data.items.length > 0) {
                const liveVideo = searchResponse.data.items[0];
                const liveUrl = `https://www.youtube.com/watch?v=${liveVideo.id.videoId}`;
                
                return {
                    isLive: true,
                    liveUrl: liveUrl,
                    title: liveVideo.snippet.title,
                    thumbnail: liveVideo.snippet.thumbnails?.default?.url,
                    videoId: liveVideo.id.videoId,
                    publishedAt: liveVideo.snippet.publishedAt
                };
            }

            return { isLive: false, liveUrl: null };
        } catch (error) {
            console.error('Error checking live status via API:', error.message);
            
            // Fallback to RSS method
            try {
                return await this.checkLiveStatusViaRSS();
            } catch (fallbackError) {
                console.error('RSS fallback also failed:', fallbackError.message);
                throw new Error('All live detection methods failed');
            }
        }
    }

    // Fallback method using RSS feed
    async checkLiveStatusViaRSS() {
        try {
            const cleanHandle = this.channelHandle.replace('@', '');
            
            // Try different RSS URL formats
            const rssUrls = [
                `https://www.youtube.com/feeds/videos.xml?channel_id=${cleanHandle}`,
                `https://www.youtube.com/feeds/videos.xml?user=${cleanHandle}`
            ];

            for (const rssUrl of rssUrls) {
                try {
                    const response = await axios.get(rssUrl, {
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });

                    // Parse RSS and check if any recent video might be live
                    // This is a basic implementation - RSS doesn't directly show live status
                    const xmlData = response.data;
                    
                    // Look for recent entries
                    const entryMatch = xmlData.match(/<entry>[\s\S]*?<\/entry>/);
                    if (entryMatch) {
                        const entry = entryMatch[0];
                        const linkMatch = entry.match(/<link rel="alternate" href="([^"]+)"/);
                        const titleMatch = entry.match(/<media:title>([^<]+)<\/media:title>/);
                        
                        if (linkMatch && titleMatch) {
                            const videoUrl = linkMatch[1];
                            const title = titleMatch[1];
                            
                            // Check if title suggests it's live (basic heuristic)
                            const liveKeywords = ['live', 'streaming', 'stream', 'going live'];
                            const isLikelyLive = liveKeywords.some(keyword => 
                                title.toLowerCase().includes(keyword)
                            );
                            
                            if (isLikelyLive) {
                                return {
                                    isLive: true,
                                    liveUrl: videoUrl,
                                    title: title,
                                    method: 'rss_heuristic'
                                };
                            }
                        }
                    }
                    
                    break; // If we got a response, don't try other URLs
                } catch (urlError) {
                    console.log(`RSS URL failed: ${rssUrl}`);
                    continue;
                }
            }

            return { isLive: false, liveUrl: null };
        } catch (error) {
            console.error('RSS check failed:', error.message);
            return { isLive: false, liveUrl: null };
        }
    }

    // Get channel information
    async getChannelInfo() {
        try {
            if (!this.apiKey) {
                return {
                    handle: this.channelHandle,
                    url: config.channel.url,
                    method: 'basic'
                };
            }

            const channelId = await this.getChannelIdFromHandle(this.channelHandle);
            
            const response = await axios.get(`${this.baseUrl}/channels`, {
                params: {
                    part: 'snippet,statistics',
                    id: channelId,
                    key: this.apiKey
                }
            });

            if (response.data.items && response.data.items.length > 0) {
                const channel = response.data.items[0];
                return {
                    handle: this.channelHandle,
                    title: channel.snippet.title,
                    description: channel.snippet.description,
                    subscriberCount: channel.statistics.subscriberCount,
                    videoCount: channel.statistics.videoCount,
                    thumbnail: channel.snippet.thumbnails?.default?.url,
                    url: config.channel.url
                };
            }

            throw new Error('Channel information not found');
        } catch (error) {
            console.error('Error getting channel info:', error.message);
            return {
                handle: this.channelHandle,
                url: config.channel.url,
                error: error.message
            };
        }
    }
}

export default YouTubeService;