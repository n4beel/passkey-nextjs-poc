# Passkey Next.js PoC

Proof of Concept for Handle Pay's passkey-based onboarding system.

## Features

### Phase 1: Foundation ✅
- Usecase selection
- Username validation & reservation
- TTL-based reservation system (30 minutes)

### Phase 2: Passkey Authentication ✅
- WebAuthn passkey registration
- Biometric login (Face ID, Touch ID, Windows Hello)
- JWT-based session management

## Tech Stack

- **Frontend**: Next.js 14, React, TailwindCSS
- **Authentication**: @simplewebauthn/browser
- **Backend API**: NestJS (separate repository)

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment:**
Create `.env.local`:
```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
```

3. **Run development server:**
```bash
npm run dev
```

4. **Open browser:**
```
http://localhost:3002
```

## Testing

### Phase 1: Username Reservation
1. Navigate to `/phase1/onboarding`
2. Select a usecase
3. Check username availability
4. Reserve username and save the token

### Phase 2: Passkey Registration
1. Navigate to `/phase2/passkey-test`
2. Enter reservation token from Phase 1
3. Create passkey with biometric authentication
4. Test login with existing passkey

**Note**: Passkeys work best with HTTPS. For local testing, use browser's built-in authenticator (not password managers like Proton Pass).

## Deployment

### Vercel (Recommended)
```bash
vercel --prod
```

Set environment variable:
- `NEXT_PUBLIC_API_URL`: Your backend API URL

## Backend

This PoC requires the Handle Pay backend running. See main repository for backend setup.

## License

Private - Handle Pay Project
