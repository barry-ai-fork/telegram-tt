
export type AuthForm = {
  email:string,
  password:string
}

export type AuthTokenForm = {
  code:string,
}

export type AuthUser = {
  user_id: string,
  email: string,
  name?: string,
  avatar?: string,
  password?: string,
  salt: string,
  github_id?:string,
  google_id?:string
};

export type AuthResponse = {
  err_msg?:string,
  token?: string,
  user?: {
    user_id: string,
    email: string,
    name?: string,
    avatar?: string,
  },
  password_empty?: boolean
};

