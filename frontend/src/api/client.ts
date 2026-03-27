import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 0 })

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg = err.response?.data?.detail || err.message || 'Request failed'
    return Promise.reject(new Error(msg))
  }
)

export default api
