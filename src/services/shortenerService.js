import axios from 'axios';
import config from '../config/config.js';

class ShortenerService {
    constructor() {
        this.apiKey = config.linktwApiKey;
        this.baseUrl = config.apis.linktw;
    }

    async shortenUrl(longUrl) {
        try {
            // Method 1: Try POST with JSON payload
            const methods = [
                {
                    method: 'post',
                    url: `${this.baseUrl}/url`,
                    data: { url: longUrl },
                    headers: {
                        'Content-Type': 'application/json',
                        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
                    }
                },
                {
                    method: 'post',
                    url: `${this.baseUrl}/shorten`,
                    data: { url: longUrl },
                    headers: {
                        'Content-Type': 'application/json',
                        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
                    }
                },
                {
                    method: 'get',
                    url: `${this.baseUrl}/shorten?url=${encodeURIComponent(longUrl)}`,
                    headers: {
                        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
                    }
                },
                {
                    method: 'post',
                    url: 'https://linktw.in/api/url',
                    data: { url: longUrl },
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            ];

            for (const methodConfig of methods) {
                try {
                    console.log(`Trying shortener method: ${methodConfig.method.toUpperCase()} ${methodConfig.url}`);
                    
                    const response = await axios({
                        ...methodConfig,
                        timeout: 10000
                    });

                    // Try different response formats
                    const possibleFields = [
                        'short_url',
                        'shortUrl', 
                        'shortened_url',
                        'url',
                        'link',
                        'short',
                        'result'
                    ];

                    for (const field of possibleFields) {
                        if (response.data && response.data[field]) {
                            const shortUrl = response.data[field];
                            if (this.isValidUrl(shortUrl)) {
                                console.log(`✅ Successfully shortened URL: ${shortUrl}`);
                                return {
                                    success: true,
                                    shortUrl: shortUrl,
                                    originalUrl: longUrl,
                                    service: 'linktw.in',
                                    method: methodConfig.method
                                };
                            }
                        }
                    }

                    // If we get here, response format might be different
                    console.log('Response data:', response.data);
                    
                } catch (methodError) {
                    console.log(`Method failed: ${methodError.message}`);
                    continue;
                }
            }

            // If all methods fail, try alternative shorteners
            return await this.tryAlternativeShorteners(longUrl);

        } catch (error) {
            console.error('Primary shortening service failed:', error.message);
            return await this.tryAlternativeShorteners(longUrl);
        }
    }

    async tryAlternativeShorteners(longUrl) {
        const alternatives = [
            {
                name: 'TinyURL',
                url: `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
                method: 'get'
            },
            {
                name: 'is.gd',
                url: 'https://is.gd/create.php',
                method: 'post',
                data: `format=simple&url=${encodeURIComponent(longUrl)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        ];

        for (const alt of alternatives) {
            try {
                console.log(`Trying alternative shortener: ${alt.name}`);
                
                const config = {
                    method: alt.method,
                    url: alt.url,
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        ...alt.headers
                    }
                };

                if (alt.data) {
                    config.data = alt.data;
                }

                const response = await axios(config);
                
                let shortUrl = response.data;
                if (typeof shortUrl === 'string') {
                    shortUrl = shortUrl.trim();
                    
                    if (this.isValidUrl(shortUrl)) {
                        console.log(`✅ Successfully shortened with ${alt.name}: ${shortUrl}`);
                        return {
                            success: true,
                            shortUrl: shortUrl,
                            originalUrl: longUrl,
                            service: alt.name,
                            fallback: true
                        };
                    }
                }
                
            } catch (altError) {
                console.log(`${alt.name} failed:`, altError.message);
                continue;
            }
        }

        // All shorteners failed, return original URL
        console.warn('All URL shortening services failed, returning original URL');
        return {
            success: false,
            shortUrl: longUrl,
            originalUrl: longUrl,
            service: 'none',
            error: 'All shortening services failed'
        };
    }

    isValidUrl(string) {
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    // Get service status
    getServiceInfo() {
        return {
            primaryService: 'linktw.in',
            baseUrl: this.baseUrl,
            hasApiKey: !!this.apiKey,
            alternatives: ['TinyURL', 'is.gd']
        };
    }
}

export default ShortenerService;