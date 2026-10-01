class FlappyBird {
  constructor(canvas, playerName, sharedState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.playerName = playerName;
    this.shared = sharedState;
    
    this.W = canvas.width;
    this.H = canvas.height;
    
    this.bird = {
      x: 80,
      y: this.H / 2,
      w: 34,
      h: 26,
      vy: 0,
      gravity: 0.2,
      flapStrength: -5,
      rotation: 0
    };
    
    this.pipeWidth = 52;
    this.pipeGap = 170;
    this.pipeSpeed = 1.2;
    this.pipeSpacing = 220;
    
    this.score = 0;
    this.gameOver = false;
    this.started = true;
    this.groundY = this.H - 40;
    this.lastScoredPipe = null;
    
    this.colors = {
      sky: '#70c5ce',
      ground: '#ded895',
      groundDark: '#c9b458',
      birdBody: '#f9c74f',
      birdWing: '#f3722c',
      birdBeak: '#e63946',
      birdEye: '#1d3557',
      pipeGreen: '#2d6a4f',
      pipeGreenLight: '#40916c',
      pipeCap: '#2d6a4f'
    };
    
    this.init();
  }
  
  init() {
    this.bird.y = this.H / 2;
    this.bird.vy = 0;
    this.score = 0;
    this.gameOver = false;
    this.started = true;
    this.lastScoredPipe = null;
  }
  
  flap() {
    if (this.gameOver || !this.started) return;
    this.bird.vy = this.bird.flapStrength;
  }
  
  update() {
    if (this.gameOver || !this.started) return;
    
    this.bird.vy += this.bird.gravity;
    this.bird.y += this.bird.vy;
    this.bird.rotation = Math.min(this.bird.vy * 3, 90);
    
    const pipes = this.shared.pipes;
    
    for (let pipe of pipes) {
      pipe.x -= this.pipeSpeed;
      if (pipe !== this.lastScoredPipe && pipe.x + this.pipeWidth < this.bird.x) {
        this.lastScoredPipe = pipe;
        this.score++;
      }
    }
    
    this.shared.pipes = pipes.filter(p => p.x > -this.pipeWidth);
    
    this.checkCollision();
  }
  
  checkCollision() {
    const b = this.bird;
    if (b.y + b.h / 2 >= this.groundY || b.y - b.h / 2 <= 0) {
      this.gameOver = true;
      return;
    }
    for (let pipe of this.shared.pipes) {
      if (b.x + b.w / 2 > pipe.x && b.x - b.w / 2 < pipe.x + this.pipeWidth) {
        if (b.y - b.h / 2 < pipe.gapY || b.y + b.h / 2 > pipe.gapY + this.pipeGap) {
          this.gameOver = true;
          return;
        }
      }
    }
  }
  
  getNextPipe() {
    for (let pipe of this.shared.pipes) {
      if (pipe.x + this.pipeWidth > this.bird.x) return pipe;
    }
    return null;
  }
  
  draw() {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.sky;
    ctx.fillRect(0, 0, this.W, this.H);
    
    this.drawClouds();
    for (let pipe of this.shared.pipes) this.drawPipe(pipe);
    this.drawGround();
    this.drawBird();
    if (this.gameOver) this.drawGameOver();
  }
  
  drawClouds() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    const time = Date.now() / 1000;
    for (let i = 0; i < 3; i++) {
      const x = ((time * 20 + i * 180) % (this.W + 100)) - 50;
      const y = 50 + i * 60;
      ctx.beginPath();
      ctx.arc(x, y, 25, 0, Math.PI * 2);
      ctx.arc(x + 20, y - 10, 20, 0, Math.PI * 2);
      ctx.arc(x + 40, y, 22, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  drawPipe(pipe) {
    const ctx = this.ctx;
    const capH = 26, capO = 3;
    ctx.fillStyle = this.colors.pipeGreen;
    ctx.fillRect(pipe.x, 0, this.pipeWidth, pipe.gapY - capH);
    ctx.fillStyle = this.colors.pipeCap;
    ctx.fillRect(pipe.x - capO, pipe.gapY - capH, this.pipeWidth + capO * 2, capH);
    const botY = pipe.gapY + this.pipeGap;
    ctx.fillStyle = this.colors.pipeGreen;
    ctx.fillRect(pipe.x, botY + capH, this.pipeWidth, this.groundY - botY - capH);
    ctx.fillStyle = this.colors.pipeCap;
    ctx.fillRect(pipe.x - capO, botY, this.pipeWidth + capO * 2, capH);
    ctx.fillStyle = this.colors.pipeGreenLight;
    ctx.fillRect(pipe.x + 4, 0, 6, pipe.gapY - capH);
    ctx.fillRect(pipe.x + 4, botY + capH, 6, this.groundY - botY - capH);
  }
  
  drawGround() {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.ground;
    ctx.fillRect(0, this.groundY, this.W, this.H - this.groundY);
    ctx.fillStyle = this.colors.groundDark;
    ctx.fillRect(0, this.groundY, this.W, 3);
    const t = Date.now() / 50;
    for (let x = -20 + (t % 40); x < this.W; x += 40) {
      ctx.fillRect(x, this.groundY + 10, 20, 4);
      ctx.fillRect(x + 10, this.groundY + 20, 20, 4);
    }
  }
  
  drawBird() {
    const ctx = this.ctx, b = this.bird;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate((b.rotation * Math.PI) / 180);
    ctx.fillStyle = this.colors.birdBody;
    ctx.beginPath();
    ctx.ellipse(0, 0, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.colors.birdWing;
    ctx.beginPath();
    ctx.ellipse(-4, Math.sin(Date.now() / 100) * 4, 12, 8, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(8, -5, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.colors.birdEye;
    ctx.beginPath();
    ctx.arc(10, -5, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.colors.birdBeak;
    ctx.beginPath();
    ctx.moveTo(14, -2); ctx.lineTo(22, 1); ctx.lineTo(14, 4); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  
  drawGameOver() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.fillStyle = '#e94560';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', this.W / 2, this.H / 2 - 20);
    ctx.fillStyle = '#ffd93d';
    ctx.font = 'bold 24px Arial';
    ctx.fillText(`Score: ${this.score}`, this.W / 2, this.H / 2 + 20);
  }
}
