#!/bin/bash

# Test script for Donna MVP API

BASE_URL="http://localhost:3000"

echo "🧪 Testing Donna MVP API..."
echo ""

# Test health endpoint
echo "1. Health check:"
curl -s "$BASE_URL/health" | jq .
echo ""

# Test receiving an email
echo "2. Sending test email:"
curl -s -X POST "$BASE_URL/api/emails/receive" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "client@example.com",
    "to": "donna@donna.ai",
    "subject": "Demande de consultation juridique",
    "body": "Bonjour Maître,\n\nJe souhaite prendre rendez-vous pour une consultation concernant un litige commercial avec mon ancien employeur. Le délai de prescription expire dans 2 mois.\n\nPouvez-vous me contacter au 06 12 34 56 78 ?\n\nCordialement,\nJean Dupont"
  }' | jq .
echo ""

# Test KPIs
echo "3. Getting KPIs:"
curl -s "$BASE_URL/api/kpis" | jq .
echo ""

# Test listing emails
echo "4. Listing emails:"
curl -s "$BASE_URL/api/emails" | jq .
echo ""

# Test listing drafts
echo "5. Listing drafts:"
curl -s "$BASE_URL/api/drafts" | jq .
echo ""

echo "✅ Tests complete!"
