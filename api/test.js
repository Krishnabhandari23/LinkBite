module.exports = async function handler(req, res) {
  try {
    console.log('Test function called successfully');
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    res.status(200).json({ 
      message: 'LinkBite API is working!',
      timestamp: new Date().toISOString(),
      method: req.method
    });
  } catch (error) {
    console.error('Test function error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
