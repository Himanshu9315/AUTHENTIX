// Entirely fictional: invented artists, invented venues, invented events. Coordinates are only
// rough city-centre areas so distance sorting behaves sensibly.

export const venues = [
  { slug: "lotus-arena", name: "Lotus Arena", city: "Delhi NCR", address: "Sector 21, Gurugram", lat: 28.4595, lng: 77.0266 },
  { slug: "yamuna-open-grounds", name: "Yamuna Open Grounds", city: "Delhi NCR", address: "Noida Expressway, Noida", lat: 28.5355, lng: 77.391 },
  { slug: "harbour-hall", name: "Harbour Hall", city: "Mumbai", address: "Lower Parel, Mumbai", lat: 18.9982, lng: 72.8258 },
  { slug: "marine-lawns", name: "Marine Lawns", city: "Mumbai", address: "Bandra Reclamation, Mumbai", lat: 19.0544, lng: 72.8205 },
  { slug: "tamarind-theatre", name: "Tamarind Theatre", city: "Bengaluru", address: "Indiranagar, Bengaluru", lat: 12.9784, lng: 77.6408 },
  { slug: "lakeview-grounds", name: "Lakeview Grounds", city: "Bengaluru", address: "Whitefield, Bengaluru", lat: 12.9698, lng: 77.7499 },
];

export const artists = [
  "Neon Monsoon", "Static Saffron", "Blue Lotus Orchestra", "The Tandoori Tapes", "Echo Bazaar",
  "Velvet Rickshaw", "Midnight Masala", "Sitar Sunset Collective", "Lunar Kite", "Pixel Pankha",
  "Dhol Division", "Jugaad Jazz Quartet", "Monsoon Mixtape", "Chai Wave", "Bhangra Bots",
  "Captain Chutney", "Auntie Algorithm", "Professor Pakoda", "Sir Reginald Samosa", "Mango Mic Drop",
].map((name) => ({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") }));

const T = (name, price, description = "") => ({ name, price, description });

// day: days from the time the seed runs. hour: local start hour (IST).
export const events = [
  { slug: "neon-monsoon-live-gurugram", title: "Neon Monsoon Live", category: "concerts", venue: "lotus-arena", day: 12, hour: 19, hours: 4, hot: true, artists: ["Neon Monsoon", "Lunar Kite"],
    description: "Synth-pop for the rainy season: Neon Monsoon bring their full light show to Lotus Arena, with Lunar Kite opening.", tiers: [T("General", 1499), T("Premium", 2999, "Closer to the stage"), T("Front Row", 5499, "Front barrier, express entry")] },
  { slug: "echo-bazaar-night-noida", title: "Echo Bazaar Night", category: "concerts", venue: "yamuna-open-grounds", day: 20, hour: 18, hours: 5, hot: false, artists: ["Echo Bazaar", "Dhol Division"],
    description: "An open-air night of folk-electronica with a live dhol ensemble.", tiers: [T("General", 999), T("Lounge", 2499, "Seating and a drink voucher")] },
  { slug: "monsoon-sound-fest-delhi", title: "Monsoon Sound Fest", category: "festivals", venue: "yamuna-open-grounds", day: 34, hour: 14, hours: 10, hot: true, artists: ["Static Saffron", "Pixel Pankha", "Velvet Rickshaw", "Bhangra Bots"],
    description: "A full-day festival with four acts, food streets and a silent-disco tent.", tiers: [T("Day Pass", 2499), T("VIP Day Pass", 6999, "VIP deck and fast-track entry")] },
  { slug: "jazz-under-the-stars-gurugram", title: "Jazz Under The Stars", category: "concerts", venue: "lotus-arena", day: 27, hour: 20, hours: 3, hot: false, artists: ["Jugaad Jazz Quartet"],
    description: "A relaxed evening of modern jazz with Indian classical touches.", tiers: [T("Standard", 1299), T("Premium", 2299)] },
  { slug: "laugh-riot-delhi", title: "Laugh Riot Live", category: "comedy", venue: "lotus-arena", day: 9, hour: 20, hours: 2, hot: false, artists: ["Captain Chutney", "Auntie Algorithm"],
    description: "Two stand-up sets on office life, WhatsApp uncles and the algorithm that runs your family.", tiers: [T("Standard", 599), T("Premium", 1199)] },
  { slug: "garden-of-beats-noida", title: "Garden of Beats", category: "festivals", venue: "yamuna-open-grounds", day: 48, hour: 13, hours: 9, hot: false, artists: ["Chai Wave", "Midnight Masala"],
    description: "A daytime garden festival with house, flea market and food trucks.", tiers: [T("Early Bird", 1299), T("General", 1799)] },

  { slug: "blue-lotus-orchestra-mumbai", title: "Blue Lotus Orchestra: Symphonic Nights", category: "concerts", venue: "harbour-hall", day: 15, hour: 19, hours: 3, hot: false, artists: ["Blue Lotus Orchestra"],
    description: "A 40-piece orchestra plays reimagined film-score classics under a single arch of lights.", tiers: [T("Balcony", 1799), T("Stalls", 3299), T("Front Stalls", 4999)] },
  { slug: "velvet-rickshaw-live-mumbai", title: "Velvet Rickshaw Live", category: "concerts", venue: "marine-lawns", day: 8, hour: 19, hours: 4, hot: true, artists: ["Velvet Rickshaw", "Monsoon Mixtape"],
    description: "Indie rock by the sea, with Monsoon Mixtape opening the night.", tiers: [T("General", 1199), T("Premium", 2499)] },
  { slug: "coastline-carnival-mumbai", title: "Coastline Carnival", category: "festivals", venue: "marine-lawns", day: 41, hour: 12, hours: 11, hot: true, artists: ["Dhol Division", "Pixel Pankha", "Chai Wave"],
    description: "A sea-facing festival with three stages and a night market.", tiers: [T("Day Pass", 2199), T("Weekend Lounge", 5999, "Lounge access and fast-track entry")] },
  { slug: "stand-up-saturday-mumbai", title: "Stand-Up Saturday", category: "comedy", venue: "harbour-hall", day: 6, hour: 21, hours: 2, hot: false, artists: ["Professor Pakoda", "Mango Mic Drop"],
    description: "Five-comic showcase for people who think commuting is a sport.", tiers: [T("Standard", 499), T("Front Row", 999)] },
  { slug: "sitar-sunset-collective-mumbai", title: "Sitar Sunset Collective", category: "concerts", venue: "marine-lawns", day: 23, hour: 17, hours: 3, hot: false, artists: ["Sitar Sunset Collective"],
    description: "A golden-hour set where sitar meets ambient electronics.", tiers: [T("Lawn", 899), T("Premium Lawn", 1799)] },
  { slug: "the-tandoori-tapes-mumbai", title: "The Tandoori Tapes: Reunion", category: "concerts", venue: "harbour-hall", day: 31, hour: 20, hours: 3, hot: false, artists: ["The Tandoori Tapes"],
    description: "A reunion show of lo-fi funk with a live visuals set.", tiers: [T("General", 1399), T("Premium", 2699)] },

  { slug: "pixel-pankha-bengaluru", title: "Pixel Pankha: Retro Rave", category: "concerts", venue: "tamarind-theatre", day: 10, hour: 20, hours: 4, hot: false, artists: ["Pixel Pankha", "Echo Bazaar"],
    description: "Chiptune meets bhangra in a retro-gaming rave.", tiers: [T("General", 1099), T("Premium", 2199)] },
  { slug: "lantern-lights-festival-bengaluru", title: "Lantern Lights Festival", category: "festivals", venue: "lakeview-grounds", day: 38, hour: 15, hours: 9, hot: true, artists: ["Static Saffron", "Lunar Kite", "Midnight Masala"],
    description: "A lakeside evening festival under thousands of lanterns.", tiers: [T("General", 1999), T("Lakeside", 4499, "Lakeside viewing deck")] },
  { slug: "comedy-cauldron-bengaluru", title: "Comedy Cauldron", category: "comedy", venue: "tamarind-theatre", day: 14, hour: 20, hours: 2, hot: false, artists: ["Sir Reginald Samosa", "Auntie Algorithm"],
    description: "A new-material night from two fan favourites.", tiers: [T("Standard", 699), T("Premium", 1299)] },
  { slug: "midnight-masala-bengaluru", title: "Midnight Masala Live", category: "concerts", venue: "lakeview-grounds", day: 18, hour: 19, hours: 4, hot: false, artists: ["Midnight Masala", "Jugaad Jazz Quartet"],
    description: "A funk and jazz fusion night on the lawn.", tiers: [T("Lawn", 1099), T("Premium Lawn", 2099)] },
  { slug: "urban-harvest-fest-bengaluru", title: "Urban Harvest Fest", category: "festivals", venue: "lakeview-grounds", day: 55, hour: 11, hours: 10, hot: false, artists: ["Chai Wave", "Bhangra Bots", "Monsoon Mixtape"],
    description: "Food, craft beer and live music across a harvest-themed weekend.", tiers: [T("Day Pass", 1599), T("Weekend Pass", 2799)] },
  { slug: "mic-drop-night-bengaluru", title: "Mic Drop Night", category: "comedy", venue: "tamarind-theatre", day: 4, hour: 19, hours: 2, hot: false, artists: ["Mango Mic Drop", "Captain Chutney"],
    description: "An open-mic style showcase with a headline set.", tiers: [T("Standard", 399), T("Premium", 799)] },
];
